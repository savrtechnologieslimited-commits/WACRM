const requiredSecrets = [
  'META_WHATSAPP_ACCESS_TOKEN',
  'META_WHATSAPP_PHONE_NUMBER_ID',
  'META_WHATSAPP_GRAPH_VERSION',
  'WHATSAPP_VERIFY_TOKEN',
  'META_APP_SECRET',
] as const

const encoder = new TextEncoder()

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i]
  return difference === 0
}

function missingSecrets(): string[] {
  return requiredSecrets.filter((name) => !Deno.env.get(name))
}

async function isValidSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const signature = signatureHeader.slice('sha256='.length)
  if (!/^[\da-f]{64}$/i.test(signature)) return false

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))
  const expected = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return constantTimeEqual(signature.toLowerCase(), expected)
}

function webhookTarget(): URL | null {
  const configured = Deno.env.get('WACRM_WEBHOOK_URL')
  if (!configured) return null

  try {
    const target = new URL(configured)
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !target.pathname.endsWith('/api/whatsapp/webhook')
    ) {
      return null
    }
    return target
  } catch {
    return null
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonError('Method not allowed', 405)
  }

  const missing = missingSecrets()
  if (missing.length > 0) {
    return jsonError(
      `WhatsApp webhook is not configured. Missing secrets: ${missing.join(', ')}`,
      503,
    )
  }

  if (request.method === 'GET') {
    const url = new URL(request.url)
    const mode = url.searchParams.get('hub.mode')
    const challenge = url.searchParams.get('hub.challenge')
    const token = url.searchParams.get('hub.verify_token')
    const verifyToken = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!

    if (
      mode !== 'subscribe' ||
      !challenge ||
      !token ||
      !constantTimeEqual(token, verifyToken)
    ) {
      return jsonError('Webhook verification failed', 403)
    }

    return new Response(challenge, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const target = webhookTarget()
  if (!target) {
    return jsonError('WACRM_WEBHOOK_URL must be a valid HTTPS webhook URL', 503)
  }

  const body = await request.arrayBuffer()
  const signature = request.headers.get('x-hub-signature-256')
  const appSecret = Deno.env.get('META_APP_SECRET')!
  if (!(await isValidSignature(body, signature, appSecret))) {
    return jsonError('Invalid webhook signature', 401)
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('content-type') ?? 'application/json',
        'x-hub-signature-256': signature!,
      },
      body,
    })
  } catch (error) {
    console.error('WACRM webhook relay failed:', error)
    return jsonError('WACRM webhook is unavailable', 502)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
    },
  })
})

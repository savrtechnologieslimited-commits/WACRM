import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { hashSignupState } from '@/lib/whatsapp/embedded-signup'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: any = null
function supabaseAdmin() {
  if (!adminClient) {
    adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return adminClient
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { app_id, configuration_id, verify_token } = body as Record<string, unknown>
    if (
      typeof app_id !== 'string' ||
      !/^\d+$/.test(app_id) ||
      typeof configuration_id !== 'string' ||
      !/^\d+$/.test(configuration_id) ||
      typeof verify_token !== 'string' ||
      verify_token.trim().length < 16 ||
      verify_token.trim().length > 256
    ) {
      return NextResponse.json(
        {
          error:
            'Enter numeric Meta App and Embedded Signup configuration IDs, plus the webhook verify token configured for your Meta app.',
        },
        { status: 400 },
      )
    }

    const { data: existingConfigs, error: existingError } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .limit(1)

    if (existingError) {
      console.error('[embedded-signup/start] config lookup failed:', existingError)
      return NextResponse.json(
        { error: 'Could not check this workspace’s WhatsApp connection.' },
        { status: 500 },
      )
    }
    if (existingConfigs?.length) {
      return NextResponse.json(
        {
          error:
            'This workspace already has a WhatsApp number connected. Create or use a separate client workspace so this signup cannot replace its connection.',
        },
        { status: 409 },
      )
    }

    const state = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const { error: insertError } = await supabaseAdmin()
      .from('whatsapp_signup_sessions')
      .insert({
        state_hash: hashSignupState(state),
        account_id: ctx.accountId,
        user_id: ctx.userId,
        app_id,
        configuration_id,
        verify_token: encrypt(verify_token.trim()),
        expires_at: expiresAt,
      })

    if (insertError) {
      console.error('[embedded-signup/start] session insert failed:', insertError)
      return NextResponse.json(
        { error: 'Could not start Embedded Signup. Check the server configuration and try again.' },
        { status: 500 },
      )
    }

    return NextResponse.json({ state, expires_at: expiresAt })
  } catch (error) {
    return toErrorResponse(error)
  }
}

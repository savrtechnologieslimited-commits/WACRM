import { createHash } from 'node:crypto';

export const COEXISTENCE_FINISH_EVENT =
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

export interface CoexistenceSessionInfo {
  type: 'WA_EMBEDDED_SIGNUP';
  event: typeof COEXISTENCE_FINISH_EVENT;
  data: {
    waba_id: string;
    phone_number_id: string;
    business_id?: string;
  };
}

export function hashSignupState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function parseCoexistenceSessionInfo(
  value: unknown
): CoexistenceSessionInfo | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Record<string, unknown>;
  const data = session.data;
  if (!data || typeof data !== 'object') return null;
  const assets = data as Record<string, unknown>;
  const messagingAccountIds = assets.messaging_account_ids;
  let wabaId: string | null = null;
  if (typeof assets.waba_id === 'string') {
    wabaId = assets.waba_id;
  } else if (
    Array.isArray(messagingAccountIds) &&
    messagingAccountIds.length === 1 &&
    typeof messagingAccountIds[0] === 'string'
  ) {
    wabaId = messagingAccountIds[0];
  }

  if (
    session.type !== 'WA_EMBEDDED_SIGNUP' ||
    session.event !== COEXISTENCE_FINISH_EVENT ||
    typeof wabaId !== 'string' ||
    !/^\d+$/.test(wabaId) ||
    typeof assets.phone_number_id !== 'string' ||
    !/^\d+$/.test(assets.phone_number_id) ||
    (assets.business_id !== undefined &&
      (typeof assets.business_id !== 'string' ||
        !/^\d+$/.test(assets.business_id)))
  ) {
    return null;
  }

  return {
    type: 'WA_EMBEDDED_SIGNUP',
    event: COEXISTENCE_FINISH_EVENT,
    data: {
      waba_id: wabaId,
      phone_number_id: assets.phone_number_id,
      ...(typeof assets.business_id === 'string'
        ? { business_id: assets.business_id }
        : {}),
    },
  };
}

export function getMetaGraphApiVersion(): string {
  const version = process.env.META_GRAPH_API_VERSION || 'v27.0';
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new Error('META_GRAPH_API_VERSION must use the format vX.Y.');
  }
  return version;
}

export function getEmbeddedSignupAppSecret(): string | null {
  const dedicatedSecret = process.env.META_EMBEDDED_SIGNUP_APP_SECRET?.trim();
  if (dedicatedSecret) return dedicatedSecret;

  const configuredSecrets = (process.env.META_APP_SECRET || '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
  return configuredSecrets.length === 1 ? configuredSecrets[0] : null;
}

async function graphRequest<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(
    `https://graph.facebook.com/${getMetaGraphApiVersion()}/${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      cache: 'no-store',
    }
  );
  const result = (await response.json().catch(() => null)) as
    (T & { error?: { message?: string; code?: number } }) | null;

  if (!response.ok || !result || result.error) {
    const code = result?.error?.code;
    const message =
      typeof result?.error?.message === 'string'
        ? result.error.message.slice(0, 400)
        : `HTTP ${response.status}`;
    throw new Error(
      `Meta Graph API request failed${code ? ` (${code})` : ''}: ${message}`
    );
  }

  return result;
}

export async function exchangeEmbeddedSignupCode(
  code: string,
  appId: string
): Promise<{
  access_token: string;
  expires_in?: number;
}> {
  const appSecret = getEmbeddedSignupAppSecret();
  if (!appSecret) {
    throw new Error(
      'Configure META_EMBEDDED_SIGNUP_APP_SECRET or a single-app META_APP_SECRET.'
    );
  }
  const url = new URL(
    `https://graph.facebook.com/${getMetaGraphApiVersion()}/oauth/access_token`
  );
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);

  const response = await fetch(url, { cache: 'no-store' });
  const result = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  } | null;
  if (!response.ok || !result?.access_token) {
    throw new Error(
      `Meta authorization-code exchange failed: ${
        result?.error?.message?.slice(0, 400) || `HTTP ${response.status}`
      }`
    );
  }

  return {
    access_token: result.access_token,
    expires_in: result.expires_in,
  };
}

export async function subscribeCoexistenceWaba(
  wabaId: string,
  accessToken: string
): Promise<void> {
  const result = await graphRequest<{ success?: boolean }>(
    `${encodeURIComponent(wabaId)}/subscribed_apps`,
    accessToken,
    { method: 'POST' }
  );
  if (result.success !== true) {
    throw new Error('Meta did not confirm the WABA app subscription.');
  }
}

export async function listCoexistenceWabaPhones(
  wabaId: string,
  accessToken: string
): Promise<
  Array<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  }>
> {
  const result = await graphRequest<{
    data?: Array<{
      id: string;
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    }>;
  }>(
    `${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100`,
    accessToken
  );
  return result.data ?? [];
}

export async function getCoexistenceWabaSubscribedApps(
  wabaId: string,
  accessToken: string
): Promise<
  Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }>
> {
  const result = await graphRequest<{
    data?: Array<{
      whatsapp_business_api_data?: { id?: string; name?: string };
    }>;
  }>(`${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken);
  return result.data ?? [];
}

export async function requestCoexistenceSync(
  phoneNumberId: string,
  accessToken: string,
  syncType: 'smb_app_state_sync' | 'history'
): Promise<string> {
  const result = await graphRequest<{ request_id?: string }>(
    `${encodeURIComponent(phoneNumberId)}/smb_app_data`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        sync_type: syncType,
      }),
    }
  );
  if (!result.request_id) {
    throw new Error(`Meta did not return a ${syncType} request ID`);
  }
  return result.request_id;
}

export async function verifyCoexistencePhone(
  phoneNumberId: string,
  accessToken: string
): Promise<{
  is_on_biz_app?: boolean;
  platform_type?: string;
  display_phone_number?: string;
}> {
  return graphRequest(
    `${encodeURIComponent(phoneNumberId)}?fields=is_on_biz_app,platform_type,display_phone_number`,
    accessToken
  );
}

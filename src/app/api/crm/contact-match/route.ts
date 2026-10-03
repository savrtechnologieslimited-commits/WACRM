import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  BridgeConfigurationError,
  InvalidBridgeTokenError,
  verifyWacrmBridgeToken,
} from '@/lib/auth/bridge-token';
import { consumeBridgeNonce } from '@/lib/auth/consume-bridge-nonce';
import { resolveCrmContactMatch } from '@/lib/contacts/crm-contact-match';

export const dynamic = 'force-dynamic';

function matchError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest) {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > 8192)
  ) {
    return matchError('The CRM contact-match request is too large.', 413);
  }
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    return matchError('Expected a JSON contact-match request.', 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return matchError('The CRM contact-match request is invalid.', 400);
  }
  if (!body || typeof body !== 'object' || !('token' in body)) {
    return matchError('The CRM contact-match token is missing.', 400);
  }
  const token = body.token;
  if (typeof token !== 'string' || !token) {
    return matchError('The CRM contact-match token is missing.', 400);
  }

  let claims;
  try {
    claims = verifyWacrmBridgeToken(
      token,
      process.env.WACRM_BRIDGE_SECRET ?? '',
      request.headers.get('origin'),
      new URL(request.url).origin
    );
  } catch (error) {
    if (error instanceof InvalidBridgeTokenError) {
      return matchError(error.message, 401);
    }
    if (error instanceof BridgeConfigurationError) {
      console.error(
        '[POST /api/crm/contact-match] bridge secret is not configured.'
      );
      return matchError('WACRM contact matching is not configured.', 503);
    }
    throw error;
  }
  if (claims.purpose !== 'contact-match' || !claims.record) {
    return matchError('This token cannot be used for contact matching.', 401);
  }

  const admin = supabaseAdmin();
  const nonceResult = await consumeBridgeNonce(
    admin,
    claims.nonce,
    claims.expiresAt
  );
  if (!nonceResult.ok && nonceResult.reason === 'database-error') {
    console.error(
      '[POST /api/crm/contact-match] failed to consume contact-match nonce:',
      nonceResult.error
    );
    return matchError('WACRM could not complete contact matching.', 500);
  }
  if (!nonceResult.ok) {
    return matchError(
      'This CRM contact-match request has already been used.',
      401
    );
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('user_id, account_id')
    .eq('email', claims.email)
    .maybeSingle();
  if (profileError) {
    console.error(
      '[POST /api/crm/contact-match] failed to resolve WACRM account:',
      profileError
    );
    return matchError('WACRM could not complete contact matching.', 500);
  }
  if (!profile?.account_id) {
    return matchError('Sign in to WACRM once before matching contacts.', 409);
  }

  const record = claims.record;
  const email = record.email?.trim().toLowerCase() ?? '';
  const phones = [...new Set(record.phones)];
  const [emailResult, phoneResult] = await Promise.all([
    email
      ? admin
          .from('contacts')
          .select('id')
          .eq('account_id', profile.account_id)
          .eq('email_normalized', email)
      : Promise.resolve({ data: [], error: null }),
    phones.length
      ? admin
          .from('contacts')
          .select('id')
          .eq('account_id', profile.account_id)
          .in('phone_normalized', phones)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (emailResult.error || phoneResult.error) {
    console.error(
      '[POST /api/crm/contact-match] failed to look up WACRM contacts:',
      emailResult.error ?? phoneResult.error
    );
    return matchError('WACRM could not complete contact matching.', 500);
  }

  return NextResponse.json(
    {
      userId: profile.user_id,
      ...resolveCrmContactMatch(
        (emailResult.data ?? []).map((contact) => contact.id),
        (phoneResult.data ?? []).map((contact) => contact.id)
      ),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

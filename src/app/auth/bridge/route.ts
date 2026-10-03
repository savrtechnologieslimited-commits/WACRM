import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/ai/admin-client';
import { createClient } from '@/lib/supabase/server';
import {
  BridgeConfigurationError,
  InvalidBridgeTokenError,
  verifyWacrmBridgeToken,
} from '@/lib/auth/bridge-token';
import { consumeBridgeNonce } from '@/lib/auth/consume-bridge-nonce';

export const dynamic = 'force-dynamic';

function bridgeError(message: string, status: number) {
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
    return bridgeError('The CRM sign-in request is too large.', 413);
  }

  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  ) {
    return bridgeError('Expected a form-encoded sign-in request.', 415);
  }

  const formData = await request.formData();
  const token = formData.get('token');
  if (typeof token !== 'string' || !token) {
    return bridgeError('The CRM sign-in token is missing.', 400);
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
      console.warn(
        '[POST /auth/bridge] rejected CRM bridge token:',
        error.reason,
        error.reason === 'audience'
          ? {
              requestOrigin: error.expectedAudience,
              tokenAudience: error.actualAudience,
            }
          : undefined
      );
      return bridgeError(error.message, 401);
    }
    if (error instanceof BridgeConfigurationError) {
      console.error('[POST /auth/bridge] bridge secret is not configured.');
      return bridgeError('WACRM single sign-on is not configured.', 503);
    }
    throw error;
  }
  if (claims.purpose !== 'signin') {
    return bridgeError('This token cannot be used for sign-in.', 401);
  }

  const admin = supabaseAdmin();
  const nonceResult = await consumeBridgeNonce(
    admin,
    claims.nonce,
    claims.expiresAt
  );
  if (!nonceResult.ok && nonceResult.reason === 'database-error') {
    console.error(
      '[POST /auth/bridge] failed to consume sign-in nonce:',
      nonceResult.error
    );
    return bridgeError('WACRM could not complete sign-in.', 500);
  }
  if (!nonceResult.ok) {
    return bridgeError('This CRM sign-in link has already been used.', 401);
  }

  const { data: existingProfile, error: profileError } = await admin
    .from('profiles')
    .select('user_id')
    .eq('email', claims.email)
    .maybeSingle();
  if (profileError) {
    console.error(
      '[POST /auth/bridge] failed to look up WACRM profile:',
      profileError
    );
    return bridgeError('WACRM could not complete sign-in.', 500);
  }

  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: claims.email,
      ...(existingProfile
        ? {}
        : { options: { data: { full_name: claims.fullName } } }),
    });
  if (linkError) {
    console.error(
      '[POST /auth/bridge] failed to create WACRM sign-in link:',
      linkError
    );
    return bridgeError(
      'WACRM could not create your account or sign-in session.',
      500
    );
  }

  const tokenHash = linkData.properties?.hashed_token;
  if (!tokenHash) {
    console.error(
      '[POST /auth/bridge] Supabase returned no magic-link token hash.'
    );
    return bridgeError('WACRM could not create a sign-in session.', 500);
  }

  const supabase = await createClient();
  const { error: sessionError } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  });
  if (sessionError) {
    console.error(
      '[POST /auth/bridge] failed to exchange WACRM sign-in link:',
      sessionError
    );
    return bridgeError('WACRM could not create a sign-in session.', 500);
  }

  const response = NextResponse.redirect(
    new URL('/dashboard', request.url),
    303
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

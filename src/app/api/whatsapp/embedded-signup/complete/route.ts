import { createClient as createAdminClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  exchangeEmbeddedSignupCode,
  listCoexistenceWabaPhones,
  parseCoexistenceSessionInfo,
  requestCoexistenceSync,
  subscribeCoexistenceWaba,
  verifyCoexistencePhone,
  hashSignupState,
} from '@/lib/whatsapp/embedded-signup';

export const runtime = 'nodejs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: any = null;
function supabaseAdmin() {
  if (!adminClient) {
    adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return adminClient;
}

type SignupSession = {
  account_id: string;
  user_id: string;
  app_id: string;
  configuration_id: string;
  verify_token: string;
};

export async function POST(request: Request) {
  let stateHash: string | null = null;
  let accountId: string | null = null;
  let userId: string | null = null;
  let connectionId: string | null = null;

  try {
    const ctx = await requireRole('admin');
    accountId = ctx.accountId;
    userId = ctx.userId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body.' },
        { status: 400 }
      );
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body.' },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;
    const { state, code } = payload;
    const sessionInfo = parseCoexistenceSessionInfo(payload.session_info);
    if (
      typeof state !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state) ||
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > 4096 ||
      !sessionInfo
    ) {
      return NextResponse.json(
        {
          error:
            'Meta did not return a valid WhatsApp Business App onboarding result.',
        },
        { status: 400 }
      );
    }

    stateHash = hashSignupState(state);
    const { data: signupSession, error: sessionError } = await supabaseAdmin()
      .from('whatsapp_signup_sessions')
      .update({ status: 'processing' })
      .eq('state_hash', stateHash)
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .select('account_id,user_id,app_id,configuration_id,verify_token')
      .maybeSingle();

    if (sessionError) {
      console.error(
        '[embedded-signup/complete] session claim failed:',
        sessionError
      );
      return NextResponse.json(
        { error: 'Could not validate this signup session.' },
        { status: 500 }
      );
    }
    if (!signupSession) {
      return NextResponse.json(
        {
          error:
            'This signup session has expired or was already used. Start again from WhatsApp settings.',
        },
        { status: 409 }
      );
    }
    const session = signupSession as SignupSession;

    const { data: existingConfigs, error: existingError } =
      await supabaseAdmin()
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', ctx.accountId)
        .limit(1);
    if (existingError)
      throw new Error('Could not verify the workspace connection state.');
    if (existingConfigs?.length) {
      throw new Error(
        'This workspace already has a WhatsApp connection. Use a separate client workspace; this signup will not replace it.'
      );
    }

    const access = await exchangeEmbeddedSignupCode(code, session.app_id);
    const accessToken = access.access_token;
    let accessTokenExpiresAt: string | null = null;
    if (access.expires_in !== undefined) {
      if (
        !Number.isFinite(access.expires_in) ||
        access.expires_in < 0 ||
        access.expires_in > (8_640_000_000_000_000 - Date.now()) / 1000
      ) {
        throw new Error('Meta returned an invalid access-token expiration.');
      }
      if (access.expires_in > 0) {
        accessTokenExpiresAt = new Date(
          Date.now() + access.expires_in * 1000
        ).toISOString();
      }
    }
    const { waba_id: wabaId, phone_number_id: phoneNumberId } =
      sessionInfo.data;

    const { data: claimedNumber, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();
    if (claimedError)
      throw new Error(
        'Could not verify whether this phone number is already connected.'
      );
    if (claimedNumber) {
      throw new Error(
        'This phone number is already connected to a WACRM workspace.'
      );
    }

    const wabaPhones = await listCoexistenceWabaPhones(wabaId, accessToken);
    const wabaPhone = wabaPhones.find((phone) => phone.id === phoneNumberId);
    if (!wabaPhone) {
      throw new Error(
        'Meta did not list the selected phone number under the returned WhatsApp Business Account.'
      );
    }

    const phoneInfo = await verifyCoexistencePhone(phoneNumberId, accessToken);
    const coexistenceVerified =
      phoneInfo.is_on_biz_app === true &&
      phoneInfo.platform_type === 'CLOUD_API';

    await subscribeCoexistenceWaba(wabaId, accessToken);

    const now = new Date();
    const verifyToken = decrypt(session.verify_token);
    const { data: inserted, error: insertError } = await supabaseAdmin()
      .from('whatsapp_config')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        phone_number_id: phoneNumberId,
        display_phone_number:
          phoneInfo.display_phone_number ??
          wabaPhone.display_phone_number ??
          null,
        waba_id: wabaId,
        meta_app_id: session.app_id,
        meta_business_id: sessionInfo.data.business_id ?? null,
        access_token: encrypt(accessToken),
        access_token_expires_at: accessTokenExpiresAt,
        verify_token: encrypt(verifyToken),
        status: 'connected',
        connected_at: now.toISOString(),
        registered_at: null,
        subscribed_apps_at: now.toISOString(),
        connection_method: 'embedded_signup_coexistence',
        coexistence_status: coexistenceVerified
          ? 'verified'
          : 'pending_verification',
        coexistence_last_checked_at: now.toISOString(),
        coexistence_sync_status: 'not_started',
        contacts_sync_status: 'not_started',
        history_sync_status: 'not_started',
        history_sync_progress: 0,
        is_primary: true,
      })
      .select('id')
      .single();

    if (insertError || !inserted?.id) {
      console.error(
        '[embedded-signup/complete] connection insert failed:',
        insertError
      );
      throw new Error(
        'Meta connected the number, but WACRM could not save the connection. Do not retry until you check WhatsApp settings.'
      );
    }
    connectionId = inserted.id as string;

    let contactsSyncRequestId: string | null = null;
    try {
      contactsSyncRequestId = await requestCoexistenceSync(
        phoneNumberId,
        accessToken,
        'smb_app_state_sync'
      );
    } catch (syncError) {
      console.error(
        '[embedded-signup/complete] contacts sync request failed:',
        syncError
      );
    }

    let historySyncRequestId: string | null = null;
    if (contactsSyncRequestId) {
      try {
        historySyncRequestId = await requestCoexistenceSync(
          phoneNumberId,
          accessToken,
          'history'
        );
      } catch (syncError) {
        console.error(
          '[embedded-signup/complete] history sync request failed:',
          syncError
        );
      }
    }

    const contactsRequested = contactsSyncRequestId !== null;
    const historyRequested = historySyncRequestId !== null;
    const syncStatus =
      contactsRequested && historyRequested
        ? 'requested'
        : contactsRequested || historyRequested
          ? 'partial'
          : 'failed';
    const { error: syncUpdateError } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        coexistence_sync_status: syncStatus,
        contacts_sync_status: contactsRequested ? 'requested' : 'failed',
        contacts_sync_request_id: contactsSyncRequestId,
        history_sync_status: historyRequested
          ? 'requested'
          : contactsRequested
            ? 'failed'
            : 'not_started',
        history_sync_request_id: historySyncRequestId,
      })
      .eq('id', connectionId)
      .eq('account_id', ctx.accountId);

    if (syncUpdateError) {
      console.error(
        '[embedded-signup/complete] sync status update failed:',
        syncUpdateError
      );
      throw new Error(
        'WhatsApp is connected, but WACRM could not record Meta’s one-time sync results. Do not retry signup; refresh settings and contact support.'
      );
    }

    const { error: completeError } = await supabaseAdmin()
      .from('whatsapp_signup_sessions')
      .update({
        status: 'completed',
        connection_id: connectionId,
        completed_at: new Date().toISOString(),
        verify_token: null,
      })
      .eq('state_hash', stateHash)
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .eq('status', 'processing');

    if (completeError) {
      console.error(
        '[embedded-signup/complete] session completion update failed:',
        completeError
      );
      throw new Error(
        'WhatsApp is connected, but WACRM could not finalize the signup record. Do not retry signup; refresh settings and contact support.'
      );
    }

    return NextResponse.json({
      success: true,
      phone_number:
        phoneInfo.display_phone_number ??
        wabaPhone.display_phone_number ??
        null,
      coexistence_status: coexistenceVerified
        ? 'verified'
        : 'pending_verification',
      coexistence_sync_status: syncStatus,
      contacts_sync_status: contactsRequested ? 'requested' : 'failed',
      history_sync_status: historyRequested
        ? 'requested'
        : contactsRequested
          ? 'failed'
          : 'not_started',
      sync_warning:
        contactsRequested && historyRequested
          ? null
          : 'Meta did not confirm both one-time sync requests. WACRM will not retry them automatically; check the sync status before taking further action.',
    });
  } catch (error) {
    if (!stateHash) return toErrorResponse(error);

    if (accountId && userId) {
      const { error: sessionUpdateError } = await supabaseAdmin()
        .from('whatsapp_signup_sessions')
        .update(
          connectionId
            ? {
                status: 'completed',
                connection_id: connectionId,
                completed_at: new Date().toISOString(),
                verify_token: null,
              }
            : { status: 'failed', verify_token: null }
        )
        .eq('state_hash', stateHash)
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .eq('status', 'processing');
      if (sessionUpdateError) {
        console.error(
          '[embedded-signup/complete] failed to finalize errored session:',
          sessionUpdateError
        );
      }
    }

    const message =
      error instanceof Error ? error.message : 'Embedded Signup failed.';
    console.error('[embedded-signup/complete] failed:', message);
    return NextResponse.json(
      { error: message },
      { status: connectionId ? 500 : 502 }
    );
  }
}

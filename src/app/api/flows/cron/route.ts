import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )'
    )
    .eq('status', 'active');

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  type Row = {
    id: string;
    flow_id: string;
    user_id: string;
    contact_id: string | null;
    last_advanced_at: string;
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null;
  };

  let swept = 0;
  for (const r of (runs ?? []) as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows;
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null);
    const lastAdvanced = new Date(r.last_advanced_at);
    const ageHours =
      (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60);
    if (ageHours < policy.on_timeout_hours) continue;

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id');

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      });
      swept += 1;
    }
  }

  const crmSync = await syncCompletedFlowsToCrm(admin, now);
  return NextResponse.json({ swept, crm_sync: crmSync });
}

type PendingFlowRun = {
  id: string;
  flow_id: string;
  contact_id: string | null;
  ended_at: string | null;
  vars: unknown;
  flows: { name: string } | { name: string }[] | null;
  contacts:
    | { id: string; name: string | null; phone: string; email: string | null }
    | { id: string; name: string | null; phone: string; email: string | null }[]
    | null;
};

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function normalizeAnswers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/(password|passcode|otp|token|secret|card|cvv|cvc|bank)/i.test(key)
      )
      .slice(0, 50)
      .map(([key, answer]) => [
        key.slice(0, 100),
        typeof answer === 'string'
          ? answer.slice(0, 600)
          : answer && typeof answer === 'object'
            ? JSON.stringify(answer).slice(0, 600)
            : answer,
      ])
  );
}

function completionDestination(value: unknown): {
  id: string;
  name: string;
  scope: 'domestic' | 'international';
  assignment_status: 'assigned' | 'unassigned' | 'ambiguous';
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const vars = value as Record<string, unknown>;
  const selection = vars['destination_selection'];
  const details =
    selection && typeof selection === 'object' && !Array.isArray(selection)
      ? (selection as Record<string, unknown>)
      : vars;
  const id = details['id'] ?? vars['destination_id'];
  const name = details['name'] ?? vars['destination'];
  const scope = details['scope'] ?? vars['destination_scope'];
  const assignmentStatus =
    details['assignment_status'] ?? vars['destination_assignment_status'];

  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id
    ) ||
    typeof name !== 'string' ||
    !name.trim() ||
    (scope !== 'domestic' && scope !== 'international') ||
    (assignmentStatus !== 'assigned' &&
      assignmentStatus !== 'unassigned' &&
      assignmentStatus !== 'ambiguous')
  ) {
    return null;
  }

  return {
    id,
    name: name.trim().slice(0, 200),
    scope,
    assignment_status: assignmentStatus,
  };
}

function answerText(
  answers: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = answers[key];
    if (typeof value === 'string' && value.trim())
      return value.trim().slice(0, 254);
  }
  return null;
}

async function syncCompletedFlowsToCrm(
  admin: ReturnType<typeof supabaseAdmin>,
  now: Date
): Promise<{ enabled: boolean; delivered: number; failed: number }> {
  const endpoint = process.env.TRAVEL_CRM_FLOW_SYNC_URL;
  if (!endpoint) return { enabled: false, delivered: 0, failed: 0 };

  const secret = process.env.WACRM_BRIDGE_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    console.error(
      '[flows-cron] CRM flow sync is configured without a valid bridge secret.'
    );
    return { enabled: true, delivered: 0, failed: 0 };
  }

  let crmEndpoint: URL;
  try {
    crmEndpoint = new URL(endpoint);
    if (
      (crmEndpoint.protocol !== 'https:' &&
        !(
          crmEndpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(crmEndpoint.hostname)
        )) ||
      crmEndpoint.username ||
      crmEndpoint.password
    ) {
      throw new Error(
        'The CRM sync URL must use HTTPS, except for localhost development.'
      );
    }
  } catch (error) {
    console.error(
      '[flows-cron] CRM flow sync URL is invalid:',
      error instanceof Error ? error.message : error
    );
    return { enabled: true, delivered: 0, failed: 0 };
  }

  const { data: pending, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, contact_id, ended_at, vars, flows!inner(name), contacts(id, name, phone, email)'
    )
    .eq('status', 'completed')
    .is('crm_sync_completed_at', null)
    .lte('crm_sync_after', now.toISOString())
    .order('ended_at', { ascending: true })
    .limit(25);

  if (error) {
    console.error(
      '[flows-cron] completed-run CRM sync scan failed:',
      error.message
    );
    return { enabled: true, delivered: 0, failed: 1 };
  }

  let delivered = 0;
  let failed = 0;
  for (const run of (pending ?? []) as PendingFlowRun[]) {
    const flow = firstRelation(run.flows);
    const contact = firstRelation(run.contacts);
    if (!flow || !contact || !run.ended_at) {
      await deferCrmSync(
        admin,
        run.id,
        'Completed flow is missing contact or flow data.',
        now
      );
      failed += 1;
      continue;
    }

    const answers = normalizeAnswers(run.vars);
    const capturedEmail = answerText(answers, [
      'email',
      'customer_email',
      'e_mail',
    ]);
    const email = contact.email?.trim() || capturedEmail;
    const payload = {
      version: 1,
      flow_run_id: run.id,
      flow_id: run.flow_id,
      wacrm_contact_id: contact.id,
      flow_name: flow.name.slice(0, 200),
      completed_at: run.ended_at,
      destination: completionDestination(run.vars),
      contact: {
        name:
          (
            contact.name?.trim() ||
            answerText(answers, ['name', 'full_name', 'customer_name'])
          )?.slice(0, 200) ?? null,
        email:
          email &&
          email.length <= 254 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            ? email
            : null,
        phone:
          (
            contact.phone.trim() ||
            answerText(answers, ['phone', 'mobile', 'whatsapp'])
          )?.slice(0, 32) ?? null,
      },
      answers,
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    let response: Response;
    try {
      response = await fetch(crmEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wacrm-timestamp': timestamp,
          'x-wacrm-signature': signature,
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (fetchError) {
      const message =
        fetchError instanceof Error
          ? fetchError.message
          : 'CRM request failed.';
      await deferCrmSync(admin, run.id, message, now);
      failed += 1;
      continue;
    }

    if (!response.ok) {
      await deferCrmSync(
        admin,
        run.id,
        `CRM returned HTTP ${response.status}.`,
        now
      );
      failed += 1;
      continue;
    }

    const { error: updateError } = await admin
      .from('flow_runs')
      .update({
        crm_sync_completed_at: now.toISOString(),
        crm_sync_attempts: 0,
        crm_sync_last_error: null,
      })
      .eq('id', run.id)
      .is('crm_sync_completed_at', null);
    if (updateError) {
      console.error(
        '[flows-cron] could not acknowledge CRM flow sync:',
        updateError.message
      );
      failed += 1;
      continue;
    }
    delivered += 1;
  }

  return { enabled: true, delivered, failed };
}

async function deferCrmSync(
  admin: ReturnType<typeof supabaseAdmin>,
  runId: string,
  error: string,
  now: Date
): Promise<void> {
  const { data: run, error: readError } = await admin
    .from('flow_runs')
    .select('crm_sync_attempts')
    .eq('id', runId)
    .maybeSingle();
  if (readError || !run) {
    console.error(
      '[flows-cron] could not read failed CRM sync attempt:',
      readError?.message
    );
    return;
  }

  const attempts = run.crm_sync_attempts + 1;
  const delayMinutes = Math.min(5 * 2 ** Math.min(attempts - 1, 7), 6 * 60);
  const { error: updateError } = await admin
    .from('flow_runs')
    .update({
      crm_sync_attempts: attempts,
      crm_sync_after: new Date(
        now.getTime() + delayMinutes * 60_000
      ).toISOString(),
      crm_sync_last_error: error.slice(0, 500),
    })
    .eq('id', runId)
    .is('crm_sync_completed_at', null);
  if (updateError) {
    console.error(
      '[flows-cron] could not defer failed CRM sync:',
      updateError.message
    );
  }
}

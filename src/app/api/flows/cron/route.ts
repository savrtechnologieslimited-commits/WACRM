import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { buildTravelCrmEnquiryPayload } from '@/lib/flows/engine';
import {
  notifyTravelCrmFlowInactivity,
  type TravelCrmEnquiryPayload,
} from '@/lib/flows/travel-crm-actions';
import { getFlowNotificationSettings } from '@/lib/flows/notification-settings';
import {
  DESTINATION_INACTIVITY_NOTIFIED_AT_VAR,
  DESTINATION_SELECTED_AT_VAR,
  shouldNotifyDestinationInactivity,
} from '@/lib/flows/destination-inactivity';
import type { FlowRunRow } from '@/lib/flows/types';

/**
 * Sweep abandoned active flow runs and alert the CRM when a customer
 * has not replied for the configured interval after selecting a destination.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. It also checks for destination
 * inactivity notifications and writes flow-run events for timeout
 * audit trails.
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
 * pinger). Run at least every five minutes for inactivity notifications
 * to arrive close to their configured threshold.
 */
function getFlowSelectedDestination(
  vars: Record<string, unknown>
): TravelCrmEnquiryPayload['destination'] {
  if (vars.__travel_crm_destination_none === true) return null;
  const selection = vars.destination_selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    return null;
  const value = selection as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.id
    ) ||
    typeof value.name !== 'string' ||
    (value.scope !== 'domestic' && value.scope !== 'international') ||
    (value.assignment_status !== 'assigned' &&
      value.assignment_status !== 'unassigned' &&
      value.assignment_status !== 'ambiguous')
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    scope: value.scope,
    assignment_status: value.assignment_status,
    assigned_employee_id: null,
  };
}

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
      'id, flow_id, account_id, user_id, contact_id, conversation_id, status, current_node_key, last_prompt_message_id, vars, reprompt_count, started_at, last_advanced_at, ended_at, end_reason, flows ( fallback_policy, trigger_config )'
    )
    .eq('status', 'active');

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!runs?.length) {
    return NextResponse.json({ swept: 0, inactivity_notified: 0, errors: 0 });
  }

  type Row = FlowRunRow & {
    flows:
      | { fallback_policy: unknown; trigger_config: unknown }
      | { fallback_policy: unknown; trigger_config: unknown }[]
      | null;
  };

  let swept = 0;
  let inactivityNotified = 0;
  let errors = 0;
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows;
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null);
    const notificationSettings = getFlowNotificationSettings(
      flowsField?.trigger_config
    );

    const selectionValue = r.vars[DESTINATION_SELECTED_AT_VAR];
    if (
      typeof selectionValue === 'string' &&
      shouldNotifyDestinationInactivity({
        status: r.status,
        vars: r.vars,
        notifyEnabled: notificationSettings.inactivity_enabled,
        lastFlowReplyAt: null,
        inactivityMinutes: notificationSettings.inactivity_minutes,
        nowMilliseconds: now.getTime(),
      })
    ) {
      const { data: flowReply, error: replyError } = await admin
        .from('flow_run_events')
        .select('created_at')
        .eq('flow_run_id', r.id)
        .eq('event_type', 'reply_received')
        .gt('created_at', selectionValue)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (replyError) {
        console.error('[flows-cron] flow-reply check failed:', {
          runId: r.id,
          message: replyError.message,
        });
        errors += 1;
        continue;
      }

      if (
        shouldNotifyDestinationInactivity({
          status: r.status,
          vars: r.vars,
          notifyEnabled: notificationSettings.inactivity_enabled,
          lastFlowReplyAt: flowReply?.created_at ?? null,
          inactivityMinutes: notificationSettings.inactivity_minutes,
          nowMilliseconds: now.getTime(),
        })
      ) {
        try {
          const payload = await buildTravelCrmEnquiryPayload(
            admin,
            r,
            {},
            true,
            false
          );
          payload.destination ??= getFlowSelectedDestination(r.vars);
          payload.inactivity_after_minutes =
            notificationSettings.inactivity_minutes;
          await notifyTravelCrmFlowInactivity(payload);
          const { error: markError } = await admin
            .from('flow_runs')
            .update({
              vars: {
                ...r.vars,
                [DESTINATION_INACTIVITY_NOTIFIED_AT_VAR]: now.toISOString(),
              },
            })
            .eq('id', r.id)
            .eq('status', 'active');
          if (markError) {
            console.error(
              '[flows-cron] inactivity notification marker failed:',
              {
                runId: r.id,
                message: markError.message,
              }
            );
            errors += 1;
          } else {
            inactivityNotified += 1;
          }
        } catch (notificationError) {
          console.error('[flows-cron] inactivity notification failed:', {
            runId: r.id,
            message:
              notificationError instanceof Error
                ? notificationError.message
                : 'Unknown notification error',
          });
          errors += 1;
        }
      }
    }

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

  return NextResponse.json(
    { swept, inactivity_notified: inactivityNotified, errors },
    { status: errors > 0 ? 500 : 200 }
  );
}

import {
  MAX_FLOW_INACTIVITY_MINUTES,
  MIN_FLOW_INACTIVITY_MINUTES,
} from './notification-settings';

export const DESTINATION_SELECTED_AT_VAR =
  '__travel_crm_destination_selected_at';
export const DESTINATION_INACTIVITY_NOTIFIED_AT_VAR =
  '__travel_crm_destination_inactivity_notified_at';

export function shouldNotifyDestinationInactivity(input: {
  status: string;
  vars: Record<string, unknown>;
  notifyEnabled: boolean;
  lastFlowReplyAt: string | null;
  inactivityMinutes: number;
  nowMilliseconds?: number;
}): boolean {
  if (
    input.status !== 'active' ||
    !input.notifyEnabled ||
    !Number.isInteger(input.inactivityMinutes) ||
    input.inactivityMinutes < MIN_FLOW_INACTIVITY_MINUTES ||
    input.inactivityMinutes > MAX_FLOW_INACTIVITY_MINUTES ||
    input.vars[DESTINATION_INACTIVITY_NOTIFIED_AT_VAR]
  ) {
    return false;
  }

  const selectedAt = input.vars[DESTINATION_SELECTED_AT_VAR];
  if (typeof selectedAt !== 'string') return false;
  const selectedAtMilliseconds = Date.parse(selectedAt);
  if (!Number.isFinite(selectedAtMilliseconds)) return false;
  const lastReplyMilliseconds = input.lastFlowReplyAt
    ? Date.parse(input.lastFlowReplyAt)
    : Number.NaN;
  const inactivityStartedAt =
    Number.isFinite(lastReplyMilliseconds) &&
    lastReplyMilliseconds > selectedAtMilliseconds
      ? lastReplyMilliseconds
      : selectedAtMilliseconds;

  const nowMilliseconds = input.nowMilliseconds ?? Date.now();
  return (
    nowMilliseconds - inactivityStartedAt >= input.inactivityMinutes * 60 * 1000
  );
}

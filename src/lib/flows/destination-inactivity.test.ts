import { describe, expect, it } from 'vitest';
import {
  DESTINATION_INACTIVITY_NOTIFIED_AT_VAR,
  DESTINATION_SELECTED_AT_VAR,
  shouldNotifyDestinationInactivity,
} from './destination-inactivity';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const selectionTime = new Date(now - 20 * 60 * 1000).toISOString();

function eligible(
  overrides: Partial<
    Parameters<typeof shouldNotifyDestinationInactivity>[0]
  > = {}
) {
  return shouldNotifyDestinationInactivity({
    status: 'active',
    vars: { [DESTINATION_SELECTED_AT_VAR]: selectionTime },
    notifyEnabled: true,
    lastFlowReplyAt: null,
    inactivityMinutes: 20,
    nowMilliseconds: now,
    ...overrides,
  });
}

describe('destination inactivity notification eligibility', () => {
  it('notifies at 20 minutes after destination selection', () => {
    expect(eligible()).toBe(true);
  });

  it('waits until the full 20-minute interval has elapsed', () => {
    expect(
      shouldNotifyDestinationInactivity({
        status: 'active',
        vars: {
          [DESTINATION_SELECTED_AT_VAR]: new Date(
            now - 19 * 60 * 1000
          ).toISOString(),
        },
        notifyEnabled: true,
        lastFlowReplyAt: null,
        inactivityMinutes: 20,
        nowMilliseconds: now,
      })
    ).toBe(false);
  });

  it('resets the delay for a reply in this flow', () => {
    expect(
      eligible({
        lastFlowReplyAt: new Date(now - 19 * 60 * 1000).toISOString(),
      })
    ).toBe(false);
    expect(
      eligible({
        lastFlowReplyAt: new Date(now - 20 * 60 * 1000).toISOString(),
      })
    ).toBe(true);
  });

  it('uses the flow-specific inactivity delay instead of a fixed duration', () => {
    expect(
      eligible({
        inactivityMinutes: 30,
        vars: {
          [DESTINATION_SELECTED_AT_VAR]: new Date(
            now - 29 * 60 * 1000
          ).toISOString(),
        },
      })
    ).toBe(false);
    expect(
      eligible({
        inactivityMinutes: 30,
        vars: {
          [DESTINATION_SELECTED_AT_VAR]: new Date(
            now - 30 * 60 * 1000
          ).toISOString(),
        },
      })
    ).toBe(true);
  });

  it('does not notify after flow completion or flow opt-out', () => {
    expect(eligible({ status: 'completed' })).toBe(false);
    expect(eligible({ notifyEnabled: false })).toBe(false);
  });

  it('does not notify twice or without a valid destination selection timestamp', () => {
    expect(
      eligible({
        vars: {
          [DESTINATION_SELECTED_AT_VAR]: selectionTime,
          [DESTINATION_INACTIVITY_NOTIFIED_AT_VAR]: '2026-11-11T12:00:00.000Z',
        },
      })
    ).toBe(false);
    expect(eligible({ vars: {} })).toBe(false);
    expect(
      eligible({ vars: { [DESTINATION_SELECTED_AT_VAR]: 'not-a-timestamp' } })
    ).toBe(false);
  });
});

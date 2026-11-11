import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOW_INACTIVITY_MINUTES,
  getFlowNotificationSettings,
  normalizeFlowInactivityMinutes,
} from './notification-settings';

describe('per-flow notification settings', () => {
  it('provides enabled legacy-compatible defaults and a configurable interval', () => {
    expect(getFlowNotificationSettings({})).toEqual({
      on_completion: true,
      inactivity_enabled: true,
      inactivity_minutes: DEFAULT_FLOW_INACTIVITY_MINUTES,
      destination_selected_enabled: false,
    });
  });

  it('reads event options and delay from a flow trigger config', () => {
    expect(
      getFlowNotificationSettings({
        notification_settings: {
          on_completion: false,
          inactivity_enabled: true,
          inactivity_minutes: 45,
          destination_selected_enabled: true,
        },
      })
    ).toEqual({
      on_completion: false,
      inactivity_enabled: true,
      inactivity_minutes: 45,
      destination_selected_enabled: true,
    });
  });

  it('preserves legacy opt-outs and rejects an invalid configured delay', () => {
    expect(
      getFlowNotificationSettings({
        notify_on_completion: false,
        notification_settings: { inactivity_minutes: 0 },
      })
    ).toEqual({
      on_completion: false,
      inactivity_enabled: false,
      inactivity_minutes: DEFAULT_FLOW_INACTIVITY_MINUTES,
      destination_selected_enabled: false,
    });
  });

  it('bounds manually entered delays to one minute through one week', () => {
    expect(normalizeFlowInactivityMinutes(0)).toBe(1);
    expect(normalizeFlowInactivityMinutes(10_081)).toBe(10_080);
  });
});

import { describe, expect, it } from 'vitest';
import { getFlowNotificationSettings } from './notification-settings';

describe('per-flow notification settings', () => {
  it('provides legacy-compatible completion and destination-selection defaults', () => {
    expect(getFlowNotificationSettings({})).toEqual({
      on_completion: true,
      destination_selected_enabled: false,
    });
  });

  it('reads event options from a flow trigger config', () => {
    expect(
      getFlowNotificationSettings({
        notification_settings: {
          on_completion: false,
          destination_selected_enabled: true,
        },
      })
    ).toEqual({
      on_completion: false,
      destination_selected_enabled: true,
    });
  });

  it('preserves legacy completion opt-outs', () => {
    expect(
      getFlowNotificationSettings({
        notify_on_completion: false,
      })
    ).toEqual({
      on_completion: false,
      destination_selected_enabled: false,
    });
  });
});

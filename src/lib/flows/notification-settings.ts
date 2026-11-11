export const DEFAULT_FLOW_INACTIVITY_MINUTES = 20;
export const MIN_FLOW_INACTIVITY_MINUTES = 1;
export const MAX_FLOW_INACTIVITY_MINUTES = 10_080;

export interface FlowNotificationSettings {
  on_completion: boolean;
  inactivity_enabled: boolean;
  inactivity_minutes: number;
  destination_selected_enabled: boolean;
}

export function getFlowNotificationSettings(
  triggerConfig: unknown
): FlowNotificationSettings {
  const config =
    triggerConfig &&
    typeof triggerConfig === 'object' &&
    !Array.isArray(triggerConfig)
      ? (triggerConfig as Record<string, unknown>)
      : {};
  const legacyEnabled = config.notify_on_completion !== false;
  const settings =
    config.notification_settings &&
    typeof config.notification_settings === 'object' &&
    !Array.isArray(config.notification_settings)
      ? (config.notification_settings as Record<string, unknown>)
      : {};
  const minutes = settings.inactivity_minutes;

  return {
    on_completion:
      typeof settings.on_completion === 'boolean'
        ? settings.on_completion
        : legacyEnabled,
    inactivity_enabled:
      typeof settings.inactivity_enabled === 'boolean'
        ? settings.inactivity_enabled
        : legacyEnabled,
    inactivity_minutes:
      typeof minutes === 'number' &&
      Number.isInteger(minutes) &&
      minutes >= MIN_FLOW_INACTIVITY_MINUTES &&
      minutes <= MAX_FLOW_INACTIVITY_MINUTES
        ? minutes
        : DEFAULT_FLOW_INACTIVITY_MINUTES,
    destination_selected_enabled:
      typeof settings.destination_selected_enabled === 'boolean'
        ? settings.destination_selected_enabled
        : false,
  };
}

export function normalizeFlowInactivityMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FLOW_INACTIVITY_MINUTES;
  return Math.min(
    MAX_FLOW_INACTIVITY_MINUTES,
    Math.max(MIN_FLOW_INACTIVITY_MINUTES, Math.trunc(value))
  );
}

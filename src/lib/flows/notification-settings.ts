export interface FlowNotificationSettings {
  on_completion: boolean;
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
  return {
    on_completion:
      typeof settings.on_completion === 'boolean'
        ? settings.on_completion
        : legacyEnabled,
    destination_selected_enabled:
      typeof settings.destination_selected_enabled === 'boolean'
        ? settings.destination_selected_enabled
        : false,
  };
}

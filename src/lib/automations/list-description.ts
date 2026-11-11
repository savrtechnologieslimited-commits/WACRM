const FOLLOW_UP_TEMPLATE_DESCRIPTION =
  /^Send a nudge if a contact has not replied within \d+ (?:minutes?|hours?|days?)\.$/

const WAIT_UNITS = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
} as const

type WaitUnit = keyof typeof WAIT_UNITS

export function getAutomationListDescription(
  description: string | null | undefined,
  waitConfig: unknown,
): string | null | undefined {
  if (!description || !FOLLOW_UP_TEMPLATE_DESCRIPTION.test(description)) {
    return description
  }
  if (typeof waitConfig !== "object" || waitConfig === null) return description

  const config = waitConfig as Record<string, unknown>
  const amount = config.amount
  const unit = config.unit
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    typeof unit !== "string" ||
    !Object.hasOwn(WAIT_UNITS, unit)
  ) {
    return description
  }

  const [singular, plural] = WAIT_UNITS[unit as WaitUnit]
  return `Send a nudge if a contact has not replied within ${amount} ${amount === 1 ? singular : plural}.`
}

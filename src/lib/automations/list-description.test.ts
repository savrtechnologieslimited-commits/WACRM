import { describe, expect, it } from "vitest"

import { getAutomationListDescription } from "./list-description"

describe("getAutomationListDescription", () => {
  it("uses the configured wait for the follow-up template description", () => {
    expect(
      getAutomationListDescription(
        "Send a nudge if a contact has not replied within 24 hours.",
        { amount: 10, unit: "minutes" },
      ),
    ).toBe("Send a nudge if a contact has not replied within 10 minutes.")
  })

  it("formats singular wait units correctly", () => {
    expect(
      getAutomationListDescription(
        "Send a nudge if a contact has not replied within 24 hours.",
        { amount: 1, unit: "hours" },
      ),
    ).toBe("Send a nudge if a contact has not replied within 1 hour.")
  })

  it("preserves custom descriptions and invalid wait configurations", () => {
    expect(
      getAutomationListDescription("My custom reminder", {
        amount: 10,
        unit: "minutes",
      }),
    ).toBe("My custom reminder")
    expect(
      getAutomationListDescription(
        "Send a nudge if a contact has not replied within 24 hours.",
        { amount: 0, unit: "minutes" },
      ),
    ).toBe("Send a nudge if a contact has not replied within 24 hours.")
  })
})

import { describe, expect, it } from "vitest";

import { validateFlowForActivation } from "./validate";
import { getFlowTemplate } from "./templates";

describe("Travel Enquiry WhatsApp Flow template", () => {
  const template = getFlowTemplate("travel_enquiry_whatsapp");

  it("is available as the exact-name, exact-greeting, once-per-contact flow", () => {
    expect(template).not.toBeNull();
    expect(template).toMatchObject({
      name: "Travel Enquiry WhatsApp Flow",
      trigger_type: "keyword",
      trigger_config: {
        keywords: ["hi", "hello", "hey"],
        match_type: "exact",
        once_per_contact: true,
      },
    });
  });

  it("contains the welcome choices, two destination branches, all answer prompts, and agent handoff", () => {
    expect(template).not.toBeNull();
    const nodes = new Map(template!.nodes.map((node) => [node.node_key, node]));
    const welcome = nodes.get("welcome");
    expect(welcome?.node_type).toBe("send_buttons");
    expect(welcome?.config).toMatchObject({
      text: "Welcome! How can we help you?",
      buttons: [
        { title: "Domestic", next_node_key: "domestic_destination" },
        { title: "International", next_node_key: "international_destination" },
        { title: "Speak to Agent", next_node_key: "agent_handoff" },
      ],
    });
    expect(nodes.get("agent_handoff")?.node_type).toBe("handoff");
    expect(nodes.get("domestic_destination")?.config).toMatchObject({
      var_key: "destination",
      next_node_key: "ask_name",
    });
    expect(nodes.get("international_destination")?.config).toMatchObject({
      var_key: "destination",
      next_node_key: "ask_name",
    });
    expect(nodes.get("ask_adults")?.config).toMatchObject({
      validation: "number",
      min_value: 1,
      invalid_input_message: "Please enter a valid number of adults (1 or more).",
    });
    expect(nodes.get("ask_travel_date")?.config).toMatchObject({
      validation: "date",
      prompt_text: expect.stringContaining("DD-MM-YYYY"),
      invalid_input_message: expect.stringContaining("DD-MM-YYYY"),
    });
    expect(nodes.get("ask_children")?.config).toMatchObject({
      validation: "number",
      min_value: 0,
      invalid_input_message: "Please enter a valid number of children (0 or more).",
    });

    const capturedKeys = template!.nodes
      .filter((node) => node.node_type === "collect_input")
      .map((node) => (node.config as { var_key: string }).var_key);
    expect(capturedKeys).toEqual([
      "destination",
      "destination",
      "name",
      "travel_date",
      "adults",
      "children",
      "departure_city",
      "budget",
      "special_requirements",
    ]);
    expect(nodes.get("complete")?.config).toMatchObject({
      text: "Thank you! We've received your travel requirements. Our team will get back to you shortly.",
      next_node_key: "end",
    });
  });

  it("is a connected, activatable graph in the existing flow validator", () => {
    expect(template).not.toBeNull();
    const issues = validateFlowForActivation(
      {
        name: template!.name,
        trigger_type: template!.trigger_type,
        trigger_config: { ...template!.trigger_config },
        entry_node_id: template!.entry_node_id,
      },
      template!.nodes.map((node) => ({
        ...node,
        config: { ...node.config },
      })),
    );

    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});

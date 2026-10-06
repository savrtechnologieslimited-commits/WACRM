# Travel CRM flow actions

The Flow Builder provides three reusable actions:

- **Travel CRM — Get Destinations** retrieves active destinations for a
  selected travel type from Travel CRM, including the assigned employee.
- **Travel CRM — Get Destination** resolves one destination and its current
  PDF URL from Travel CRM.
- **Travel CRM — Complete Enquiry** sends the flow answers to Travel CRM's
  existing signed completion callback and stores the confirmed enquiry ID
  and number in flow variables.

These actions do not copy destination or PDF data into WACRM. Configure the
server-only `TRAVEL_CRM_DESTINATIONS_URL`, `TRAVEL_CRM_FLOW_SYNC_URL`, and
`WACRM_BRIDGE_SECRET` values using the Travel CRM deployment's HTTPS
endpoints. The bridge secret must match on both services and must not be
exposed to the browser or Flow Builder.

Dynamic Send List can map destination fields to its display title and reply
ID, then capture the selected destination and employee in flow variables.
Send Media accepts variable interpolation such as `{{destination.pdf_url}}`;
enable its empty-URL skip option to continue if no PDF is available. Route
each Travel CRM action's failure output to a customer-safe message or agent
handoff. Completion variables are set only after the callback confirms that
the CRM enquiry was created.

Existing static Send List and Send Media configurations remain supported.

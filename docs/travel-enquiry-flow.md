# Existing Travel Enquiry WhatsApp Flow

The existing **Travel Enquiry WhatsApp Flow** is adapted in place. Migration
`038_adapt_existing_travel_enquiry_flow.sql` updates matching saved legacy flow
graphs without creating another flow, changing the trigger, or replacing the
existing questionnaire. The matching template also defines this behavior for a
future clone.

When a customer chooses a scope, the flow loads domestic or international
destinations from Travel CRM. Configure
`TRAVEL_CRM_DESTINATIONS_URL` to the CRM's `/api/wacrm/destinations` endpoint
and set `WACRM_BRIDGE_SECRET` to the same private secret in both applications.
The POST body is signed as HMAC-SHA256 over `${timestamp}.${rawBody}` and sent
with `x-wacrm-timestamp` and `x-wacrm-signature` headers.

For the Vercel production deployment, use:

```env
NEXT_PUBLIC_SITE_URL=https://wacrm-pearl-ten.vercel.app
CRM_ORIGIN=https://travel-crm-khaki.vercel.app
TRAVEL_CRM_DESTINATIONS_URL=https://travel-crm-khaki.vercel.app/api/wacrm/destinations
TRAVEL_CRM_FLOW_SYNC_URL=https://travel-crm-khaki.vercel.app/api/wacrm/flow-completed
```

`NEXT_PUBLIC_SITE_URL` is WACRM's own public origin; `CRM_ORIGIN` is the
Travel CRM origin permitted to embed WACRM.
Redeploy WACRM after changing its Vercel environment variables so the running
deployment receives the updated configuration.

Destination choices are paginated into WhatsApp lists of no more than ten
rows. Selecting one stores its ID, name, scope, and assignment/readiness status
in the flow answers. If the destination has a signed PDF URL, WACRM sends that
document before asking the remaining questions; destinations without a PDF
continue without one. Lookup failure or an empty scope is surfaced to the
customer and handed to an agent.

WACRM does not assign employees. The assignment status is informational; the
Travel CRM remains responsible for assigning the completed enquiry.
Completed answers are retried through the existing
`TRAVEL_CRM_FLOW_SYNC_URL` integration when its outbox migration is installed.

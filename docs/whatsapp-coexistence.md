# WhatsApp Business App Coexistence

WACRM provides an admin-only Meta Embedded Signup path for eligible WhatsApp
Business App numbers. It uses the existing `whatsapp_config` tenant mapping,
AES-GCM credential encryption, outbound messaging implementation and signed
webhook endpoint. The existing manual credentials workflow remains available.

This flow does not guarantee Meta eligibility or approval. A connection is
reported as Coexistence-verified only after Meta confirms
`is_on_biz_app=true` and `platform_type=CLOUD_API`; otherwise WACRM displays
pending verification. Successful Cloud API sends alone are not evidence that
the Business App remains connected.

## Meta-provided test number

Meta's Cloud API Get Started guide provides test number credentials through
the app dashboard's **WhatsApp → API Setup** panel
([Meta Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)).
Enter the test Phone Number ID, WABA ID, and access token in the existing
**Settings → WhatsApp → WhatsApp connection** form. WACRM does not fetch
Partner Tools credentials automatically. Meta-pre-registered test numbers do
not need a two-step PIN; leave that field blank. The same form validates and
stores these credentials through the normal `whatsapp_config` connection path.
Temporary Meta test tokens expire, so replace a rejected token with a fresh
one from API Setup.

## Database and Vercel configuration

Apply `supabase/migrations/047_whatsapp_embedded_signup.sql` and
`supabase/migrations/048_whatsapp_signup_inputs.sql` to the Supabase project
before enabling the feature.

Configure these server-side Vercel environment variables:

| Variable                          | Purpose                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_SECRET`                 | Existing server-only app secret used for webhook signatures and (when it contains exactly one secret) authorization-code exchange. |
| `META_EMBEDDED_SIGNUP_APP_SECRET` | Optional server-only override for code exchange when `META_APP_SECRET` contains multiple app secrets.                              |
| `META_GRAPH_API_VERSION`          | Optional Embedded Signup Graph API version; defaults to the current Meta example, `v27.0`.                                         |

Enter the public Meta App ID, Embedded Signup configuration ID, and the same
webhook verification token configured in the Meta app in the WhatsApp setup
page for each connection attempt. WACRM stores the IDs with the resulting
connection and encrypts the verification token. The Meta app secret remains
server-only and must belong to the app used for that attempt. Do not use a
`NEXT_PUBLIC_` prefix for any secret or access token. The browser receives
only public IDs, one-time state, and safe connection status; access tokens are
exchanged server-side and encrypted before storage. When Meta returns a
positive `expires_in`, WACRM records the token expiration; a non-expiring token
has no expiration timestamp.

The existing manual WhatsApp API helper is independently pinned to Graph API
`v21.0`; `META_GRAPH_API_VERSION` does not change it. Meta lists `v21.0` as
available until January 21, 2027, so plan a tested upgrade before that date.

## Meta dashboard requirements

Before customer testing, an administrator with access to the Meta app must:

1. Configure Facebook Login for Business with the **WhatsApp Embedded
   Signup** login variation, select the WhatsApp products your integration
   intends to offer, and use the resulting configuration ID above. Use an
   Embedded Signup v5 configuration. Meta deprecated v2 and v3 on October 15,
   2026, and released v5 on October 20, 2026. WACRM launches v5 with
   `extras.version: "v5"`; WhatsApp Business App Coexistence is enabled by
   default in v5. The Facebook Login for Business configuration controls
   requested permissions; do not override it with an extra `scope` parameter
   in `FB.login`. Do not use a configuration whose dashboard still reports
   **Permissions incomplete**. V5 returns `messaging_account_ids` and
   `phone_number_id`; WACRM normalizes a single messaging account ID to its
   existing WABA mapping. The server parser also accepts the v4 `waba_id`
   payload. A builder label such as `Feature Type: None` does not override the
   launch version.
   Meta requires the integrating business to be an approved Tech Provider or
   Solution Partner; standard Cloud API credentials alone do not grant this
   access.
2. Configure the app's Facebook Login for Business / Embedded Signup settings,
   allowed domains, Valid OAuth redirect URIs, and OAuth/JavaScript SDK toggles
   according to the current Meta Tech Provider requirements. For the Cloud API
   flow, request
   Advanced Access for `whatsapp_business_management` and
   `whatsapp_business_messaging`; WACRM does not request `business_management`
   because this flow does not use it. Grant only the permissions and products
   the integration needs; for example, Marketing Messages API is optional if
   WACRM will not use it. Extra selected products can add consent terms to the
   customer's flow. Customer approval and app review/advanced access may be
   required. Use Meta's current permission/configuration guidance rather than
   copying permissions from a different app.
3. Set the app webhook callback URL to
   `https://<deployment-host>/api/whatsapp/webhook`. Use the webhook
   verification token entered for that connection, and retain `META_APP_SECRET`
   for raw-body `x-hub-signature-256` validation.
4. Subscribe the WhatsApp Business Account webhook fields `messages`
   (including delivery statuses), `account_update`,
   `history`, `smb_app_state_sync`, and `smb_message_echoes`. The last three
   are required to receive synchronization progress, app contacts, and
   mobile-app-originated message echoes.
5. Ensure the WhatsApp webhook permissions and app subscriptions are approved
   and active for the Tech Provider integration. WACRM subscribes each
   customer's WABA through `/{WABA_ID}/subscribed_apps` after signup.
6. Confirm the customer's WhatsApp Business app is on version 2.24.17 or
   newer, and use a number Meta deems eligible. Meta's documented flow verifies
   the number with a code delivered to the Business App, then asks the
   customer to connect the number and confirm whether to share chat history;
   the current documentation does not describe QR scanning as a requirement.
   The Embedded Signup completion event must be
   `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; a normal `FINISH` Cloud API flow
   is rejected by WACRM.
7. Ask the customer to add a payment method in WhatsApp Manager before they
   start sending Cloud API messages. Meta's Tech Provider onboarding guide
   assigns this action to the customer.

Meta currently documents a fixed throughput of 20 messages per second (mps)
for numbers shared between the Business App and Cloud API, and synchronization
of individual chat history for the most recent six months. The Coexistence
requirements page checked for this guide specifies the app-version floor and
Tech Provider/Solution Partner status, but does not state a minimum number
activation age or a country allowlist; eligibility is determined by Meta's
onboarding flow.

Meta's feature and API requirements can change. Confirm the current
configuration and required permissions in the Meta app dashboard and official
documentation before production onboarding:

- [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Embedded Signup versioning](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions)
- [Embedded Signup v5](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-5)
- [Onboarding WhatsApp Business App users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [SMB app state sync webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync)
- [SMB message echoes webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes)
- [History webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history)

## Behavior and safety

- Only account admins can start or complete Embedded Signup.
- Signup state is random, hashed at rest, single-use, bound to the initiating
  account/admin, and expires after ten minutes. Callback session data must
  identify the official Coexistence completion event and valid WABA/phone IDs.
- The authorization code is exchanged immediately server-to-server. The
  Coexistence path deliberately does **not** call `/{PHONE_NUMBER_ID}/register`:
  Meta says the number is already registered during this flow.
- After WABA subscription, WACRM initiates contacts sync first and initiates
  history sync only after Meta accepts the contacts request and returns its
  request ID. Meta allows each request once per onboarding and gives a 24-hour
  window. Request IDs and request results are stored in the existing
  tenant-owned config row. If contacts sync fails, history sync is not started.
  WACRM does not automatically retry an ambiguous sync failure because Meta
  documents these operations as one-time.
- `history` imports idempotently into the existing inbox message/conversation
  tables. History messages do not increment unread counts or trigger customer
  automations. `smb_message_echoes` are stored as agent messages; edit/revoke
  events update the original message only within the matching phone-number
  inbox. Contact add/edit events update or create the account-scoped contact.
  Removing a Business App phone-book contact does not delete the richer CRM
  contact record. WABA IDs are checked against the phone-number connection
  before processing Coexistence webhook data.
- Webhook HMAC validation applies before all webhook event handling. Duplicate
  message IDs use the existing conversation/message uniqueness boundary.
- `Disconnect from WACRM` removes the selected encrypted connection from the
  CRM and stops CRM sends; it does not offboard the number from Cloud API.
  Meta currently requires the business to disconnect through WhatsApp Business
  app **Settings → Account → Business Platform → Disconnect Account**.
- Coexistence supports eligible one-to-one messaging and contact sync. It
  does not sync group chats, calls, broadcast lists, or several WhatsApp
  Business app tools. The 180-day history window excludes groups; history
  media asset IDs are only provided for media sent within 14 days of
  onboarding. Existing companion clients are unlinked during onboarding;
  supported devices can be linked again afterward.
- Cloud API messages remain subject to template/customer-service-window and
  Cloud API pricing rules. Business App messages remain subject to the
  Business App's own behavior and are not a substitute for Cloud API policy.

## Test plan

1. Apply migration 047 in a non-production Supabase environment and configure
   the variables and Meta dashboard fields above.
2. Use a Meta test app/business and an eligible existing WhatsApp Business App
   number. Start as a WACRM account admin and complete the flow as the actual
   business owner; verify an ineligible/cancelled attempt shows a clear error
   and does not expose a token.
3. Confirm Meta returns `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; verify the
   WACRM status shows `verified` only when Meta also returns both expected
   phone status fields. Confirm the code is exchanged server-side, the
   encrypted token is stored, and no browser response/query contains it.
4. Confirm app subscription, contact/history sync request IDs, and all three
   Coexistence webhook fields. Keep the Business App open while Meta syncs.
5. Send a test message from the Business App and a customer test phone; verify
   both appear once in the correct tenant/thread and app-originated messages
   display as agent messages. Exercise edit/revoke, contact add/edit/remove,
   duplicate delivery, history sharing and history declined cases.
6. Reply from WACRM and confirm it uses the connected phone's token and that
   the number remains usable in the Business App. Confirm that unsupported
   companion devices/group chats are not represented as supported. Test CRM
   disconnect separately and verify Meta offboarding remains an explicit
   Business App action.
7. Repeat with a different WACRM account and prove it cannot view, mutate or
   send from the first account's connection.

Local code/tests do not prove Meta eligibility, app review approval, dashboard
subscriptions, production permissions, or real mobile-app coexistence. Those
must be verified with Meta-configured test accounts and a real eligible
Business App number before describing the integration as production-ready.

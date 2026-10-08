# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. This includes
  `NEXT_PUBLIC_APP_LOCALE` (`en | ko | pt | es`), so the UI language is
  fixed per image.
- Everything else (`WHATSAPP_SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_WHATSAPP_SUPABASE_URL=https://your-whatsapp-project.supabase.co \
  --build-arg NEXT_PUBLIC_WHATSAPP_SUPABASE_ANON_KEY=your-whatsapp-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- The Meta callback can use the `whatsapp-webhook` Supabase Edge
  Function in the dedicated WhatsApp project:
  `https://<WHATSAPP_PROJECT_REF>.supabase.co/functions/v1/whatsapp-webhook`.
  Set `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`,
  `META_WHATSAPP_GRAPH_VERSION`, `WHATSAPP_VERIFY_TOKEN`,
  `META_APP_SECRET`, and `WACRM_WEBHOOK_URL` as Edge Function secrets in
  that project. `WACRM_WEBHOOK_URL` must be the HTTPS URL of this app's
  `/api/whatsapp/webhook` route. The Edge Function rejects requests until
  those values are configured, verifies Meta's signature, and relays
  inbound events to WACRM. WACRM itself must use the dedicated
  WhatsApp Supabase URL, anon key, and service-role key from
  `.env.local.example`; do not point these at the Travel CRM project.
  Deploy with
  `supabase functions deploy whatsapp-webhook --project-ref <WHATSAPP_PROJECT_REF> --no-verify-jwt`.
  After configuration, set Meta's callback URL to the Edge Function URL
  and subscribe to `messages`.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `.env.local.example`). Both return
  503 until that variable is set.
- For completed travel flows to appear as CRM customer requirements, apply
  `supabase/migrations/037_crm_flow_completion_outbox.sql` to WACRM and
  `20261004100000_wacrm_completed_flow_requirements.sql` to the Travel CRM
  database. Configure `TRAVEL_CRM_FLOW_SYNC_URL` and the shared
  `WACRM_BRIDGE_SECRET` in WACRM, and keep the `/api/flows/cron` schedule
  running. Completed runs, including previously completed runs, are retried
  until the CRM confirms receipt.

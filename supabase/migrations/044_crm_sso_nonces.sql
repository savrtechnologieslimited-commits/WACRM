CREATE TABLE IF NOT EXISTS public.wacrm_sso_nonces (
  nonce UUID PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wacrm_sso_nonces ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wacrm_sso_nonces FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wacrm_sso_nonces TO service_role;

CREATE INDEX IF NOT EXISTS idx_wacrm_sso_nonces_expires_at
  ON public.wacrm_sso_nonces (expires_at);

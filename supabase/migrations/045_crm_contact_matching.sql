ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS email_normalized TEXT
  GENERATED ALWAYS AS (lower(btrim(email))) STORED;

CREATE INDEX IF NOT EXISTS idx_contacts_account_email_normalized
  ON public.contacts (account_id, email_normalized)
  WHERE email_normalized <> '';

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_method TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS coexistence_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS coexistence_sync_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS contacts_sync_request_id TEXT,
  ADD COLUMN IF NOT EXISTS history_sync_request_id TEXT,
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacts_sync_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS history_sync_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS history_sync_progress INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS history_sync_error_code INTEGER;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_business_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_connection_method_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_connection_method_check
      CHECK (connection_method IN ('manual', 'embedded_signup_coexistence'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_coexistence_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_coexistence_status_check
      CHECK (coexistence_status IN ('not_applicable', 'pending_verification', 'verified', 'setup_error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_coexistence_sync_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_coexistence_sync_status_check
      CHECK (coexistence_sync_status IN ('not_started', 'requested', 'partial', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_contacts_sync_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_contacts_sync_status_check
      CHECK (contacts_sync_status IN ('not_started', 'requested', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_history_sync_status_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_history_sync_status_check
      CHECK (history_sync_status IN ('not_started', 'requested', 'in_progress', 'completed', 'declined', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_history_sync_progress_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_history_sync_progress_check
      CHECK (history_sync_progress BETWEEN 0 AND 100);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS whatsapp_signup_sessions (
  state_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  connection_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS whatsapp_signup_sessions_expiry_idx
  ON whatsapp_signup_sessions (expires_at);

ALTER TABLE whatsapp_signup_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE whatsapp_signup_sessions FROM anon, authenticated;

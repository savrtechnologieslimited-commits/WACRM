ALTER TABLE whatsapp_signup_sessions
  ADD COLUMN IF NOT EXISTS app_id TEXT,
  ADD COLUMN IF NOT EXISTS configuration_id TEXT,
  ADD COLUMN IF NOT EXISTS verify_token TEXT;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_app_id TEXT,
  ADD COLUMN IF NOT EXISTS coexistence_last_checked_at TIMESTAMPTZ;

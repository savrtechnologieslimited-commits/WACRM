ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS crm_sync_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crm_sync_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS crm_sync_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_sync_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_flow_runs_pending_crm_sync
  ON flow_runs (crm_sync_after, ended_at)
  WHERE status = 'completed' AND crm_sync_completed_at IS NULL;

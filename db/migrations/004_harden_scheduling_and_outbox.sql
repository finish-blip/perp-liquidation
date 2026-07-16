ALTER TABLE liquidation_tasks
  ADD COLUMN priority INT NOT NULL DEFAULT 100 AFTER action,
  ADD COLUMN claimed_by VARCHAR(128) AFTER status,
  ADD COLUMN claim_expires_at DATETIME(6) AFTER claimed_by,
  ADD KEY idx_liquidation_tasks_claim (status, claim_expires_at, priority, created_at);

ALTER TABLE liquidation_outbox_events
  ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER payload,
  ADD COLUMN next_attempt_at DATETIME(6) AFTER attempt_count,
  ADD COLUMN last_error VARCHAR(1024) AFTER next_attempt_at,
  ADD COLUMN locked_by VARCHAR(128) AFTER last_error,
  ADD COLUMN locked_until DATETIME(6) AFTER locked_by,
  ADD COLUMN dead_lettered_at DATETIME(6) AFTER locked_until,
  ADD KEY idx_liquidation_outbox_dispatch
    (published_at, dead_lettered_at, next_attempt_at, locked_until, id);

CREATE TABLE liquidation_worker_leases (
  worker_id VARCHAR(128) PRIMARY KEY,
  worker_type VARCHAR(64) NOT NULL,
  lease_expires_at DATETIME(6) NOT NULL,
  metadata JSON,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_liquidation_worker_leases_type (worker_type, lease_expires_at)
);

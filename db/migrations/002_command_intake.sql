ALTER TABLE inbox_messages
  ADD COLUMN disposition VARCHAR(32) NOT NULL DEFAULT 'RECEIVED' AFTER task_id,
  ADD KEY idx_inbox_disposition (disposition, received_at);

CREATE TABLE risk_unit_command_sequences (
  risk_unit_id VARCHAR(128) NOT NULL,
  latest_decision_sequence BIGINT UNSIGNED NOT NULL,
  latest_message_id VARCHAR(96) NOT NULL,
  latest_task_id VARCHAR(96) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (risk_unit_id),
  KEY idx_risk_unit_command_sequences_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

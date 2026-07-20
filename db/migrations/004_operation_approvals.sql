CREATE TABLE operation_approvals (
  approval_id VARCHAR(96) NOT NULL,
  action_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(96) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  status VARCHAR(32) NOT NULL,
  requested_by VARCHAR(128) NOT NULL,
  decided_by VARCHAR(128) NULL,
  decision_reason VARCHAR(512) NULL,
  requested_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3) NULL,
  executed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (approval_id),
  KEY idx_operation_approvals_status (status, requested_at),
  KEY idx_operation_approvals_target (action_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

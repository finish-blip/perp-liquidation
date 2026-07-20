CREATE TABLE inbox_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id VARCHAR(96) NOT NULL,
  source VARCHAR(64) NOT NULL,
  correlation_id VARCHAR(96) NOT NULL,
  command_type VARCHAR(64) NOT NULL,
  decision_sequence BIGINT UNSIGNED NOT NULL,
  risk_unit_id VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  received_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL,
  task_id VARCHAR(96) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbox_message_id (message_id),
  KEY idx_inbox_risk_unit_sequence (risk_unit_id, decision_sequence),
  KEY idx_inbox_processed_at (processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tasks (
  id VARCHAR(96) NOT NULL,
  inbox_message_id VARCHAR(96) NOT NULL,
  correlation_id VARCHAR(96) NOT NULL,
  risk_unit_id VARCHAR(128) NOT NULL,
  command_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  status_reason VARCHAR(512) NULL,
  priority INT NOT NULL DEFAULT 0,
  decision_sequence BIGINT UNSIGNED NOT NULL,
  fencing_token BIGINT UNSIGNED NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  command_payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tasks_inbox_message_id (inbox_message_id),
  UNIQUE KEY uq_tasks_risk_unit_sequence (risk_unit_id, decision_sequence),
  KEY idx_tasks_claimable (status, priority, lease_expires_at, created_at),
  KEY idx_tasks_risk_unit_status (risk_unit_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE execution_steps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id VARCHAR(96) NOT NULL,
  step_sequence INT UNSIGNED NOT NULL,
  strategy VARCHAR(32) NOT NULL,
  quantity_mode VARCHAR(16) NOT NULL,
  requested_quantity VARCHAR(80) NOT NULL,
  remaining_quantity VARCHAR(80) NOT NULL,
  status VARCHAR(32) NOT NULL,
  plan_payload JSON NOT NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_execution_steps_task_sequence (task_id, step_sequence),
  KEY idx_execution_steps_task_status (task_id, status),
  CONSTRAINT fk_execution_steps_task_id FOREIGN KEY (task_id) REFERENCES tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id VARCHAR(96) NOT NULL,
  execution_step_id BIGINT UNSIGNED NOT NULL,
  attempt_sequence INT UNSIGNED NOT NULL,
  client_order_id VARCHAR(96) NOT NULL,
  exchange_order_id VARCHAR(128) NULL,
  status VARCHAR(32) NOT NULL,
  requested_quantity VARCHAR(80) NOT NULL,
  requested_price VARCHAR(80) NULL,
  filled_quantity VARCHAR(80) NOT NULL DEFAULT '0',
  last_event_sequence BIGINT UNSIGNED NULL,
  request_payload JSON NOT NULL,
  response_payload JSON NULL,
  submitted_at DATETIME(3) NULL,
  terminal_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_attempts_client_order_id (client_order_id),
  UNIQUE KEY uq_order_attempts_step_attempt (execution_step_id, attempt_sequence),
  KEY idx_order_attempts_task_status (task_id, status),
  CONSTRAINT fk_order_attempts_task_id FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT fk_order_attempts_execution_step_id FOREIGN KEY (execution_step_id) REFERENCES execution_steps (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id VARCHAR(96) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  event_sequence BIGINT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_task_events_sequence (task_id, event_sequence),
  KEY idx_task_events_task_type (task_id, event_type),
  CONSTRAINT fk_task_events_task_id FOREIGN KEY (task_id) REFERENCES tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outbox_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id VARCHAR(96) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(96) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  locked_by VARCHAR(128) NULL,
  locked_until DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  last_error VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_message_id (message_id),
  KEY idx_outbox_dispatch (status, next_attempt_at, locked_until),
  KEY idx_outbox_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_unit_leases (
  risk_unit_id VARCHAR(128) NOT NULL,
  fencing_token BIGINT UNSIGNED NOT NULL,
  owner VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (risk_unit_id),
  KEY idx_risk_unit_leases_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

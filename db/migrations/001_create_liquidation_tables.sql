CREATE TABLE liquidation_tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  risk_decision_id VARCHAR(128) NOT NULL,
  risk_unit_id VARCHAR(128) NOT NULL,
  decision_sequence BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  position_id VARCHAR(64) NOT NULL,
  position_version BIGINT NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  position_side VARCHAR(16) NOT NULL,
  target_quantity DECIMAL(36,18),
  max_executable_quantity DECIMAL(36,18),
  order_type VARCHAR(16),
  reduce_only BOOLEAN,
  time_in_force VARCHAR(16),
  max_slippage DECIMAL(18,8),
  status VARCHAR(32) NOT NULL,
  fencing_token BIGINT,
  order_id VARCHAR(128),
  executed_quantity DECIMAL(36,18) NOT NULL DEFAULT 0,
  average_price DECIMAL(36,18),
  fee DECIMAL(36,18),
  settled_position_version BIGINT,
  retry_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME(6),
  error_code VARCHAR(64),
  error_message VARCHAR(1024),
  expire_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6),
  UNIQUE KEY uk_liquidation_tasks_task_id (task_id),
  UNIQUE KEY uk_liquidation_tasks_decision (risk_decision_id),
  UNIQUE KEY uk_liquidation_tasks_unit_sequence (risk_unit_id, decision_sequence),
  KEY idx_liquidation_tasks_status_retry (status, next_retry_at),
  KEY idx_liquidation_tasks_position_status (position_id, status),
  KEY idx_liquidation_tasks_user_symbol (user_id, symbol)
);

CREATE TABLE liquidation_risk_snapshots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  risk_decision_id VARCHAR(128) NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'risk-system',
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_risk_snapshots_task (task_id),
  CONSTRAINT fk_liquidation_risk_snapshots_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_executions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  execution_sequence INT NOT NULL,
  client_order_id VARCHAR(128) NOT NULL,
  order_id VARCHAR(128),
  requested_quantity DECIMAL(36,18) NOT NULL,
  executed_quantity DECIMAL(36,18) NOT NULL DEFAULT 0,
  average_price DECIMAL(36,18),
  fee DECIMAL(36,18),
  status VARCHAR(32) NOT NULL,
  request_payload JSON NOT NULL,
  response_payload JSON,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_executions_client_order (client_order_id),
  UNIQUE KEY uk_liquidation_executions_task_sequence (task_id, execution_sequence),
  KEY idx_liquidation_executions_order (order_id),
  CONSTRAINT fk_liquidation_executions_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_task_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  external_event_id VARCHAR(128),
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_task_events_external (external_event_id),
  KEY idx_liquidation_task_events_task (task_id, id),
  CONSTRAINT fk_liquidation_task_events_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_inbox_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  external_event_id VARCHAR(128) NOT NULL,
  topic VARCHAR(128) NOT NULL,
  received_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_inbox_events_external (external_event_id)
);

CREATE TABLE liquidation_outbox_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  event_id VARCHAR(128) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  topic VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  published_at DATETIME(6),
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_outbox_events_event (event_id),
  KEY idx_liquidation_outbox_events_pending (published_at, id),
  CONSTRAINT fk_liquidation_outbox_events_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_risk_unit_leases (
  risk_unit_id VARCHAR(128) PRIMARY KEY,
  owner_task_id VARCHAR(128) NOT NULL,
  fencing_token BIGINT NOT NULL,
  lease_expires_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
);

CREATE TABLE liquidation_reconciliation_issues (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  issue_type VARCHAR(64) NOT NULL,
  expected_payload JSON,
  actual_payload JSON,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  created_at DATETIME(6) NOT NULL,
  resolved_at DATETIME(6),
  KEY idx_liquidation_reconciliation_open (status, created_at),
  CONSTRAINT fk_liquidation_reconciliation_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

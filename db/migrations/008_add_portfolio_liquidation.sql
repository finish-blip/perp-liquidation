CREATE TABLE liquidation_portfolio_plans (
  plan_id VARCHAR(128) PRIMARY KEY,
  risk_decision_id VARCHAR(128) NOT NULL,
  risk_unit_id VARCHAR(128) NOT NULL,
  decision_sequence BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  account_version BIGINT NOT NULL,
  current_account_version BIGINT NOT NULL,
  margin_mode VARCHAR(16) NOT NULL,
  execution_priority INT NOT NULL,
  max_total_authorized_notional DECIMAL(36,18) NOT NULL,
  failure_mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  current_item_sequence INT,
  item_count INT NOT NULL,
  completed_item_count INT NOT NULL DEFAULT 0,
  error_code VARCHAR(64),
  error_message VARCHAR(1024),
  raw_payload JSON NOT NULL,
  expire_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6),
  UNIQUE KEY uk_portfolio_plans_decision (risk_decision_id),
  UNIQUE KEY uk_portfolio_plans_scope_sequence (risk_unit_id, decision_sequence),
  KEY idx_portfolio_plans_scope_status (risk_unit_id, status),
  KEY idx_portfolio_plans_account_status (account_id, status)
);

ALTER TABLE liquidation_tasks
  ADD COLUMN execution_scope_id VARCHAR(128) AFTER child_order_timeout_ms,
  ADD COLUMN portfolio_plan_id VARCHAR(128) AFTER execution_scope_id,
  ADD COLUMN plan_item_sequence INT AFTER portfolio_plan_id,
  ADD COLUMN authorized_notional DECIMAL(36,18) AFTER plan_item_sequence,
  ADD KEY idx_liquidation_tasks_execution_scope (execution_scope_id, status),
  ADD KEY idx_liquidation_tasks_portfolio (portfolio_plan_id, plan_item_sequence);

UPDATE liquidation_tasks SET execution_scope_id = risk_unit_id WHERE execution_scope_id IS NULL;

ALTER TABLE liquidation_tasks
  MODIFY execution_scope_id VARCHAR(128) NOT NULL;

CREATE TABLE liquidation_portfolio_plan_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id VARCHAR(128) NOT NULL,
  item_sequence INT NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  position_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  authorized_notional DECIMAL(36,18) NOT NULL,
  status VARCHAR(32) NOT NULL,
  result_payload JSON,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6),
  UNIQUE KEY uk_portfolio_items_sequence (plan_id, item_sequence),
  UNIQUE KEY uk_portfolio_items_task (task_id),
  KEY idx_portfolio_items_status (plan_id, status, item_sequence),
  CONSTRAINT fk_portfolio_items_plan FOREIGN KEY (plan_id) REFERENCES liquidation_portfolio_plans(plan_id),
  CONSTRAINT fk_portfolio_items_task FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_portfolio_plan_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_portfolio_plan_events_plan (plan_id, id),
  CONSTRAINT fk_portfolio_plan_events_plan FOREIGN KEY (plan_id) REFERENCES liquidation_portfolio_plans(plan_id)
);

CREATE TABLE liquidation_operator_actions (
  operation_id VARCHAR(128) PRIMARY KEY,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(128) NOT NULL,
  operator_id VARCHAR(128) NOT NULL,
  approver_id VARCHAR(128) NOT NULL,
  approval_id VARCHAR(128) NOT NULL,
  reason VARCHAR(1024) NOT NULL,
  status VARCHAR(32) NOT NULL,
  result_payload JSON,
  created_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6),
  KEY idx_operator_actions_target (target_type, target_id, created_at),
  KEY idx_operator_actions_approval (approval_id)
);

CREATE TABLE liquidation_execution_steps (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  step_sequence INT NOT NULL,
  quantity DECIMAL(36,18) NOT NULL,
  order_type VARCHAR(16) NOT NULL,
  time_in_force VARCHAR(16),
  max_slippage DECIMAL(18,8),
  status VARCHAR(32) NOT NULL DEFAULT 'PLANNED',
  executed_quantity DECIMAL(36,18) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6),
  UNIQUE KEY uk_liquidation_steps_task_sequence (task_id, step_sequence),
  KEY idx_liquidation_steps_task_status (task_id, status),
  CONSTRAINT fk_liquidation_steps_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_order_attempts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  step_sequence INT NOT NULL,
  attempt_sequence INT NOT NULL,
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
  UNIQUE KEY uk_liquidation_attempts_client_order (client_order_id),
  UNIQUE KEY uk_liquidation_attempts_task_sequence (task_id, step_sequence, attempt_sequence),
  KEY idx_liquidation_attempts_order (order_id),
  CONSTRAINT fk_liquidation_attempts_step
    FOREIGN KEY (task_id, step_sequence)
    REFERENCES liquidation_execution_steps(task_id, step_sequence)
);

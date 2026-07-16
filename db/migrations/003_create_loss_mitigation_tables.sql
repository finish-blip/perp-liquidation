CREATE TABLE liquidation_bankruptcy_checks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  check_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  bankruptcy_price DECIMAL(36,18),
  bankruptcy_loss DECIMAL(36,18) NOT NULL DEFAULT 0,
  currency VARCHAR(32),
  response_payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_bankruptcy_task (task_id),
  UNIQUE KEY uk_liquidation_bankruptcy_check (check_id),
  CONSTRAINT fk_liquidation_bankruptcy_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_insurance_claims (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  requested_amount DECIMAL(36,18) NOT NULL,
  covered_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  currency VARCHAR(32),
  response_payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_liquidation_insurance_task (task_id),
  UNIQUE KEY uk_liquidation_insurance_claim (claim_id),
  CONSTRAINT fk_liquidation_insurance_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE liquidation_adl_requests (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id VARCHAR(128) NOT NULL,
  adl_request_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  requested_amount DECIMAL(36,18) NOT NULL,
  covered_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  currency VARCHAR(32),
  response_payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  settled_at DATETIME(6),
  UNIQUE KEY uk_liquidation_adl_task (task_id),
  UNIQUE KEY uk_liquidation_adl_request (adl_request_id),
  CONSTRAINT fk_liquidation_adl_task
    FOREIGN KEY (task_id) REFERENCES liquidation_tasks(task_id)
);

CREATE TABLE integration_loss_policy (
  id INT PRIMARY KEY,
  bankruptcy_price DECIMAL(36,18),
  bankruptcy_loss DECIMAL(36,18) NOT NULL DEFAULT 0,
  insurance_coverage_ratio DECIMAL(18,8) NOT NULL DEFAULT 1,
  currency VARCHAR(32) NOT NULL DEFAULT 'USDT',
  updated_at DATETIME(6) NOT NULL
);

CREATE TABLE integration_bankruptcy_checks (
  task_id VARCHAR(128) PRIMARY KEY,
  check_id VARCHAR(128) NOT NULL,
  bankruptcy_price DECIMAL(36,18),
  bankruptcy_loss DECIMAL(36,18) NOT NULL,
  currency VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_integration_bankruptcy_check (check_id)
);

CREATE TABLE integration_insurance_claims (
  task_id VARCHAR(128) PRIMARY KEY,
  claim_id VARCHAR(128) NOT NULL,
  requested_amount DECIMAL(36,18) NOT NULL,
  covered_amount DECIMAL(36,18) NOT NULL,
  currency VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_integration_insurance_claim (claim_id)
);

CREATE TABLE integration_adl_requests (
  task_id VARCHAR(128) PRIMARY KEY,
  adl_request_id VARCHAR(128) NOT NULL,
  requested_amount DECIMAL(36,18) NOT NULL,
  covered_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  currency VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_integration_adl_request (adl_request_id)
);

INSERT INTO integration_loss_policy
  (id, bankruptcy_price, bankruptcy_loss, insurance_coverage_ratio, currency, updated_at)
VALUES
  (1, NULL, 0, 1, 'USDT', UTC_TIMESTAMP(6));

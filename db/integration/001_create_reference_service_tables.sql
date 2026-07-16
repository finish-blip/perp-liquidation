CREATE TABLE integration_positions (
  position_id VARCHAR(64) PRIMARY KEY,
  version BIGINT NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  side VARCHAR(16) NOT NULL,
  size DECIMAL(36,18) NOT NULL,
  updated_at DATETIME(6) NOT NULL
);

CREATE TABLE integration_orders (
  order_id VARCHAR(128) PRIMARY KEY,
  client_order_id VARCHAR(128) NOT NULL,
  task_id VARCHAR(128) NOT NULL,
  risk_decision_id VARCHAR(128) NOT NULL,
  risk_unit_id VARCHAR(128) NOT NULL,
  position_id VARCHAR(64) NOT NULL,
  expected_position_version BIGINT NOT NULL,
  fencing_token BIGINT NOT NULL,
  side VARCHAR(16) NOT NULL,
  quantity DECIMAL(36,18) NOT NULL,
  filled_quantity DECIMAL(36,18) NOT NULL DEFAULT 0,
  average_price DECIMAL(36,18),
  fee DECIMAL(36,18),
  status VARCHAR(32) NOT NULL,
  request_payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uk_integration_orders_client_order (client_order_id)
);

CREATE TABLE integration_fencing_tokens (
  risk_unit_id VARCHAR(128) PRIMARY KEY,
  latest_token BIGINT NOT NULL,
  updated_at DATETIME(6) NOT NULL
);

CREATE TABLE integration_cancellations (
  task_id VARCHAR(128) PRIMARY KEY,
  risk_decision_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL
);

CREATE TABLE integration_risk_results (
  event_id VARCHAR(128) PRIMARY KEY,
  topic VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL
);

INSERT INTO integration_positions
  (position_id, version, user_id, account_id, symbol, side, size, updated_at)
VALUES
  ('888', 42, '1001', 'acc_1001', 'BTCUSDT', 'LONG', 0.01000000, UTC_TIMESTAMP(6));

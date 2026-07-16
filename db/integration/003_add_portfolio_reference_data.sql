CREATE TABLE integration_accounts (
  account_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  version BIGINT NOT NULL,
  margin_mode VARCHAR(16) NOT NULL,
  settlement_currency VARCHAR(32) NOT NULL,
  updated_at DATETIME(6) NOT NULL
);

INSERT INTO integration_accounts
  (account_id, user_id, version, margin_mode, settlement_currency, updated_at)
VALUES
  ('acc_1001', '1001', 88, 'CROSS', 'USDT', UTC_TIMESTAMP(6));

INSERT INTO integration_positions
  (position_id, version, user_id, account_id, symbol, side, size, updated_at)
VALUES
  ('889', 70, '1001', 'acc_1001', 'ETHUSDT', 'LONG', 2, UTC_TIMESTAMP(6));

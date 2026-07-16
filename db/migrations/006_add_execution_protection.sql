ALTER TABLE liquidation_tasks
  ADD COLUMN quantity_mode VARCHAR(16) NOT NULL DEFAULT 'EXACT' AFTER max_executable_quantity,
  ADD COLUMN bankruptcy_price DECIMAL(36,18) AFTER max_slippage,
  ADD COLUMN max_liquidation_deviation DECIMAL(18,8) AFTER bankruptcy_price,
  ADD COLUMN quote_max_age_ms INT AFTER max_liquidation_deviation;

ALTER TABLE liquidation_tasks
  ADD COLUMN execution_strategy VARCHAR(16) NOT NULL DEFAULT 'STATIC' AFTER quote_max_age_ms,
  ADD COLUMN execution_urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL' AFTER execution_strategy,
  ADD COLUMN max_child_orders INT AFTER execution_urgency,
  ADD COLUMN max_child_quantity DECIMAL(36,18) AFTER max_child_orders,
  ADD COLUMN min_child_quantity DECIMAL(36,18) AFTER max_child_quantity,
  ADD COLUMN max_book_participation DECIMAL(18,8) AFTER min_child_quantity,
  ADD COLUMN child_order_cooldown_ms INT AFTER max_book_participation,
  ADD COLUMN child_order_timeout_ms INT AFTER child_order_cooldown_ms,
  ADD KEY idx_liquidation_tasks_symbol_status (symbol, status);

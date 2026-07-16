ALTER TABLE liquidation_tasks
  ADD KEY idx_liquidation_tasks_status_id (status, id),
  ADD KEY idx_liquidation_tasks_status_updated (status, updated_at),
  ADD KEY idx_liquidation_tasks_symbol_status (symbol, status);

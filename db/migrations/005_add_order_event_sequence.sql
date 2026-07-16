ALTER TABLE liquidation_order_attempts
  ADD COLUMN last_event_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER status;

CREATE TABLE order_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(96) NOT NULL,
  client_order_id VARCHAR(96) NOT NULL,
  event_sequence BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  disposition VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
  received_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_events_event_id (event_id),
  UNIQUE KEY uq_order_events_client_sequence (client_order_id, event_sequence),
  KEY idx_order_events_disposition (disposition, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settlement_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(96) NOT NULL,
  client_order_id VARCHAR(96) NOT NULL,
  settlement_sequence BIGINT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  disposition VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
  received_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_settlement_events_event_id (event_id),
  UNIQUE KEY uq_settlement_events_client_sequence (client_order_id, settlement_sequence),
  KEY idx_settlement_events_disposition (disposition, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

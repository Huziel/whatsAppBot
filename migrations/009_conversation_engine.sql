CREATE TABLE IF NOT EXISTS conversation_turns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  jid VARCHAR(191) NOT NULL,
  wa_message_id VARCHAR(191) NOT NULL,
  status ENUM('received','processing','action_applied','send_pending','sent','failed','uncertain') NOT NULL DEFAULT 'received',
  settings_version BIGINT UNSIGNED NOT NULL,
  outcome_kind VARCHAR(40) NULL,
  outbound_text LONGTEXT NULL,
  outbound_message_id VARCHAR(191) NULL,
  send_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_conversation_turn (jid,wa_message_id),
  UNIQUE KEY uq_conversation_outbound (outbound_message_id),
  KEY idx_conversation_turn_status (status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_effects (
  effect_key VARCHAR(191) NOT NULL PRIMARY KEY,
  effect_type VARCHAR(40) NOT NULL,
  result_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pending_intents (
  jid VARCHAR(191) NOT NULL PRIMARY KEY,
  intent_kind VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  source_message_id VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_pending_intents_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

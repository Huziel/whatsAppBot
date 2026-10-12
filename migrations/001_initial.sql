CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone_number VARCHAR(32) NULL,
  display_name VARCHAR(255) NULL,
  identity_status ENUM('resolved','unresolved') NOT NULL DEFAULT 'unresolved',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_contacts_phone (phone_number),
  KEY idx_contacts_identity_status (identity_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contact_identifiers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  jid VARCHAR(191) NOT NULL,
  identifier_type ENUM('pn','lid') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_contact_identifiers_jid (jid),
  KEY idx_contact_identifiers_contact (contact_id),
  CONSTRAINT fk_identifiers_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  last_message_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_chats_contact (contact_id),
  KEY idx_chats_last_message (last_message_at),
  CONSTRAINT fk_chats_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id BIGINT UNSIGNED NOT NULL,
  wa_message_id VARCHAR(191) NOT NULL,
  from_me BOOLEAN NOT NULL,
  sender_jid VARCHAR(191) NULL,
  message_type VARCHAR(80) NOT NULL,
  text LONGTEXT NULL,
  message_timestamp DATETIME(3) NOT NULL,
  status VARCHAR(40) NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at DATETIME(3) NULL,
  raw_payload JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_messages_dedup (chat_id, wa_message_id, from_me),
  KEY idx_messages_timestamp (message_timestamp),
  KEY idx_messages_sender (sender_jid),
  CONSTRAINT fk_messages_chat FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

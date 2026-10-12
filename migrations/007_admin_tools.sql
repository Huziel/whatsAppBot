CREATE TABLE IF NOT EXISTS chat_settings (
  contact_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  bot_paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_chat_settings_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  total DECIMAL(12,2) NULL,
  currency CHAR(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_orders_status_created (status,created_at),
  KEY idx_orders_contact (contact_id,created_at),
  CONSTRAINT fk_orders_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NULL,
  sku VARCHAR(64) NOT NULL,
  item_type ENUM('product','service') NOT NULL,
  item_name VARCHAR(200) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price DECIMAL(12,2) NULL,
  currency CHAR(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

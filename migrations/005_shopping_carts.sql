CREATE TABLE IF NOT EXISTS shopping_carts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_shopping_carts_contact (contact_id),
  CONSTRAINT fk_shopping_carts_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shopping_cart_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cart_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NULL,
  sku VARCHAR(64) NOT NULL,
  item_type ENUM('product','service') NOT NULL,
  item_name VARCHAR(200) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price DECIMAL(12,2) NULL,
  currency CHAR(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_shopping_cart_sku (cart_id,sku),
  KEY idx_shopping_cart_items_inventory (inventory_item_id),
  CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES shopping_carts(id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_items_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

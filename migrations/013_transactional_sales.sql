SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='inventory_items' AND COLUMN_NAME='reserved_quantity'),
  'DO 0',
  'ALTER TABLE inventory_items ADD COLUMN reserved_quantity INT UNSIGNED NOT NULL DEFAULT 0 AFTER stock_quantity'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='inventory_items' AND CONSTRAINT_NAME='chk_inventory_reserved_quantity'),
  'DO 0',
  'ALTER TABLE inventory_items ADD CONSTRAINT chk_inventory_reserved_quantity CHECK ((stock_quantity IS NULL AND reserved_quantity = 0) OR (stock_quantity IS NOT NULL AND reserved_quantity <= stock_quantity))'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

ALTER TABLE orders
  MODIFY COLUMN status ENUM('pending','confirmed','preparing','ready','out_for_delivery','completed','cancelled','expired') NOT NULL DEFAULT 'pending';

SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='public_id'),'DO 0','ALTER TABLE orders ADD COLUMN public_id VARCHAR(20) NULL AFTER public_order_key');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='public_access_token_hash'),'DO 0','ALTER TABLE orders ADD COLUMN public_access_token_hash BINARY(32) NULL AFTER public_id');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='public_request_hash'),'DO 0','ALTER TABLE orders ADD COLUMN public_request_hash BINARY(32) NULL AFTER public_access_token_hash');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='source'),'DO 0',"ALTER TABLE orders ADD COLUMN source ENUM('dashboard','public_menu','whatsapp') NOT NULL DEFAULT 'dashboard' AFTER public_request_hash");
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='customer_name'),'DO 0','ALTER TABLE orders ADD COLUMN customer_name VARCHAR(160) NULL AFTER source');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='customer_phone'),'DO 0','ALTER TABLE orders ADD COLUMN customer_phone VARCHAR(20) NULL AFTER customer_name');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='payment_status'),'DO 0',"ALTER TABLE orders ADD COLUMN payment_status ENUM('unpaid','pending','paid','failed','refunded') NOT NULL DEFAULT 'unpaid' AFTER customer_phone");
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='reservation_status'),'DO 0',"ALTER TABLE orders ADD COLUMN reservation_status ENUM('none','active','sold','released','expired') NOT NULL DEFAULT 'none' AFTER payment_status");
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='expires_at'),'DO 0','ALTER TABLE orders ADD COLUMN expires_at DATETIME(3) NULL AFTER reservation_status');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='confirmed_at'),'DO 0','ALTER TABLE orders ADD COLUMN confirmed_at DATETIME(3) NULL AFTER expires_at');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='cancelled_at'),'DO 0','ALTER TABLE orders ADD COLUMN cancelled_at DATETIME(3) NULL AFTER confirmed_at');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='expired_at'),'DO 0','ALTER TABLE orders ADD COLUMN expired_at DATETIME(3) NULL AFTER cancelled_at');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

UPDATE orders SET source='public_menu' WHERE public_order_key IS NOT NULL AND source='dashboard';

SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='uq_orders_public_id'),'DO 0','ALTER TABLE orders ADD UNIQUE KEY uq_orders_public_id (public_id)');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_expiration'),'DO 0','ALTER TABLE orders ADD KEY idx_orders_expiration (status,reservation_status,expires_at,id)');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
SET @migration_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_payment'),'DO 0','ALTER TABLE orders ADD KEY idx_orders_payment (payment_status,updated_at,id)');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  order_item_id BIGINT UNSIGNED NOT NULL,
  inventory_item_id BIGINT UNSIGNED NULL,
  sku VARCHAR(64) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  status ENUM('reserved','sold','released') NOT NULL DEFAULT 'reserved',
  expires_at DATETIME(3) NULL,
  finalized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_inventory_reservation_order_item (order_item_id),
  KEY idx_inventory_reservations_expiration (status,expires_at,id),
  KEY idx_inventory_reservations_item (inventory_item_id,status),
  CONSTRAINT fk_inventory_reservations_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_reservations_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_reservations_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inventory_item_id BIGINT UNSIGNED NULL,
  order_id BIGINT UNSIGNED NULL,
  order_item_id BIGINT UNSIGNED NULL,
  sku VARCHAR(64) NOT NULL,
  movement_type ENUM('reserve','release','sale','adjustment') NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  event_key VARCHAR(191) NOT NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_inventory_movements_event (event_key),
  KEY idx_inventory_movements_item (inventory_item_id,created_at,id),
  KEY idx_inventory_movements_order (order_id,created_at,id),
  CONSTRAINT fk_inventory_movements_inventory FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_movements_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

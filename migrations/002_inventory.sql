USE whatsapp_local;

CREATE TABLE IF NOT EXISTS inventory_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_type ENUM('product','service') NOT NULL,
  sku VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  price DECIMAL(12,2) NULL,
  currency CHAR(3) NOT NULL DEFAULT 'MXN',
  stock_quantity INT UNSIGNED NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_inventory_sku (sku),
  KEY idx_inventory_active_type (is_active,item_type),
  KEY idx_inventory_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO inventory_items (item_type,sku,name,description,price,currency,stock_quantity,is_active) VALUES
  ('product','DEMO-PRODUCT-001','Producto demo (reemplazar)','Registro de demostración; no es un artículo comercial real.',100.00,'MXN',10,FALSE),
  ('service','DEMO-SERVICE-001','Servicio demo (reemplazar)','Registro de demostración; reemplazar antes de ofrecer servicios.',500.00,'MXN',NULL,FALSE);

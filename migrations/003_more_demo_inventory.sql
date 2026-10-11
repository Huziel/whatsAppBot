USE whatsapp_local;

INSERT IGNORE INTO inventory_items (item_type,sku,name,description,price,currency,stock_quantity,is_active) VALUES
  ('product','DEMO-PRODUCT-002','DEMO - Termo de acero','Producto de demostración de 600 ml.',249.00,'MXN',8,FALSE),
  ('product','DEMO-PRODUCT-003','DEMO - Cuaderno','Cuaderno de demostración de 100 hojas.',89.00,'MXN',25,FALSE),
  ('product','DEMO-PRODUCT-004','DEMO - Audífonos','Audífonos alámbricos de demostración.',499.00,'MXN',4,FALSE),
  ('product','DEMO-PRODUCT-005','DEMO - Taza cerámica','Taza de demostración; existencias en cero para probar agotados.',129.00,'MXN',0,FALSE),
  ('product','DEMO-PRODUCT-006','DEMO - Cable USB-C','Cable de demostración; existencias no controladas.',149.00,'MXN',NULL,FALSE),
  ('service','DEMO-SERVICE-002','DEMO - Asesoría básica','Sesión de asesoría de demostración de 30 minutos.',350.00,'MXN',NULL,FALSE),
  ('service','DEMO-SERVICE-003','DEMO - Instalación','Servicio de instalación de demostración; precio ilustrativo.',800.00,'MXN',NULL,FALSE),
  ('service','DEMO-SERVICE-004','DEMO - Mantenimiento','Servicio de mantenimiento de demostración; precio ilustrativo.',600.00,'MXN',NULL,FALSE);

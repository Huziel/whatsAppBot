USE whatsapp_local;

ALTER TABLE inventory_items ADD COLUMN image_url VARCHAR(2048) NULL AFTER description;

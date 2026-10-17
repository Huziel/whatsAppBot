ALTER TABLE orders
  ADD COLUMN public_order_key CHAR(36) NULL AFTER currency,
  ADD UNIQUE KEY uq_orders_public_order_key (public_order_key);

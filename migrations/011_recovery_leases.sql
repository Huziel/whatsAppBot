ALTER TABLE conversation_turns
  MODIFY status ENUM('received','processing','action_applied','send_pending','sending','sent','failed','uncertain') NOT NULL DEFAULT 'received',
  ADD COLUMN recovery_token CHAR(36) NULL,
  ADD COLUMN recovery_lease_until DATETIME(3) NULL,
  ADD KEY idx_conversation_recovery_lease (status,recovery_lease_until,id);

ALTER TABLE messages
  ADD KEY idx_messages_retention (message_timestamp,id);

ALTER TABLE conversation_turns
  ADD KEY idx_conversation_cleanup (status,updated_at,id),
  ADD KEY idx_conversation_jid_id (jid,id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at_id
  ON public.messages (conversation_id, created_at DESC, id DESC);

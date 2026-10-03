-- Allow multiple WhatsApp senders per account while keeping the existing
-- configuration as the account's primary sender.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT;

UPDATE whatsapp_config AS config
SET is_primary = TRUE
WHERE config.id = (
  SELECT candidate.id
  FROM whatsapp_config AS candidate
  WHERE candidate.account_id = config.account_id
  ORDER BY candidate.created_at ASC NULLS LAST, candidate.id
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM whatsapp_config AS existing_primary
  WHERE existing_primary.account_id = config.account_id
    AND existing_primary.is_primary
);

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary_per_account
  ON whatsapp_config (account_id)
  WHERE is_primary;

-- A contact's identity is scoped to the WhatsApp number it first contacted.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel_phone_number_id TEXT;

UPDATE contacts AS contact
SET channel_phone_number_id = config.phone_number_id
FROM whatsapp_config AS config
WHERE contact.account_id = config.account_id
  AND config.is_primary
  AND contact.channel_phone_number_id IS NULL;

DROP INDEX IF EXISTS idx_contacts_account_phone_normalized;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_phone_normalized
  ON contacts (
    account_id,
    COALESCE(channel_phone_number_id, ''),
    phone_normalized
  )
  WHERE phone_normalized <> '';

DROP INDEX IF EXISTS idx_contacts_account_wa_user_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_wa_user_id
  ON contacts (
    account_id,
    COALESCE(channel_phone_number_id, ''),
    wa_user_id
  )
  WHERE wa_user_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_phone_number_id TEXT;

UPDATE conversations AS conversation
SET channel_phone_number_id = contact.channel_phone_number_id
FROM contacts AS contact
WHERE conversation.contact_id = contact.id
  AND conversation.account_id = contact.account_id
  AND conversation.channel_phone_number_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations (account_id, channel_phone_number_id);

-- Campaigns persist the sender chosen at creation time, so scheduled and
-- resumed broadcasts cannot silently switch numbers.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

UPDATE broadcasts AS broadcast
SET phone_number_id = config.phone_number_id
FROM whatsapp_config AS config
WHERE broadcast.account_id = config.account_id
  AND config.is_primary
  AND broadcast.phone_number_id IS NULL;

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS waba_id TEXT;

UPDATE message_templates AS template
SET waba_id = config.waba_id
FROM whatsapp_config AS config
WHERE template.account_id = config.account_id
  AND config.is_primary
  AND template.waba_id IS NULL;

DROP INDEX IF EXISTS message_templates_user_name_language_key;

CREATE INDEX IF NOT EXISTS idx_message_templates_account_waba_name_language
  ON message_templates (account_id, waba_id, name, language);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id UUID,
  p_user_id UUID,
  p_name TEXT,
  p_template_name TEXT,
  p_template_language TEXT,
  p_total_recipients INTEGER,
  p_contact_ids UUID[],
  p_template_params JSONB[],
  p_phone_number_id TEXT
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, phone_number_id
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients, p_phone_number_id
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) TO service_role;

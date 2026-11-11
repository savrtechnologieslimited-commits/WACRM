ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'new_whatsapp_lead'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_whatsapp_lead_once
  ON public.notifications(user_id, conversation_id)
  WHERE type = 'new_whatsapp_lead';

CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
  v_source TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone)
  INTO v_contact_name
  FROM public.contacts
  WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name
    INTO v_actor_name
    FROM public.profiles
    WHERE user_id = auth.uid();
  END IF;

  v_source := CASE
    WHEN NEW.channel_phone_number_id IS NOT NULL THEN ' via WhatsApp'
    ELSE ''
  END;

  INSERT INTO public.notifications (
    account_id,
    user_id,
    type,
    conversation_id,
    contact_id,
    actor_user_id,
    title,
    body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'Lead assigned to you',
    COALESCE(v_actor_name, 'A teammate') || ' assigned lead '
      || COALESCE(v_contact_name, 'a contact') || ' to you' || v_source || '.'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_conversation_assigned() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.notify_new_whatsapp_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_contact_id UUID;
  v_contact_name TEXT;
BEGIN
  IF NEW.sender_type <> 'customer' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.messages AS previous_message
    WHERE previous_message.conversation_id = NEW.conversation_id
      AND previous_message.sender_type = 'customer'
      AND previous_message.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT conversation.account_id,
         conversation.contact_id,
         COALESCE(NULLIF(contact.name, ''), contact.phone)
  INTO v_account_id, v_contact_id, v_contact_name
  FROM public.conversations AS conversation
  JOIN public.contacts AS contact ON contact.id = conversation.contact_id
  WHERE conversation.id = NEW.conversation_id
    AND conversation.channel_phone_number_id IS NOT NULL;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (
    account_id,
    user_id,
    type,
    conversation_id,
    contact_id,
    title,
    body
  )
  SELECT
    v_account_id,
    profile.user_id,
    'new_whatsapp_lead',
    NEW.conversation_id,
    v_contact_id,
    'New WhatsApp lead',
    'New lead ' || COALESCE(v_contact_name, 'a contact') || ' came in through WhatsApp.'
  FROM public.profiles AS profile
  WHERE profile.account_id = v_account_id
    AND profile.account_role IN ('owner', 'admin')
  ON CONFLICT (user_id, conversation_id)
    WHERE type = 'new_whatsapp_lead'
    DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create WhatsApp lead notification for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_new_whatsapp_lead() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_new_whatsapp_lead() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_new_whatsapp_lead_message ON public.messages;
CREATE TRIGGER on_new_whatsapp_lead_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_whatsapp_lead();

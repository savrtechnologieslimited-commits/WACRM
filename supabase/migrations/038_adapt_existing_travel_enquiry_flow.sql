DO $$
DECLARE
  travel_flow record;
  next_question_key text;
  migrated_count integer := 0;
BEGIN
  FOR travel_flow IN
    SELECT flow.id, flow.entry_node_id
    FROM public.flows AS flow
    WHERE flow.name = 'Travel Enquiry WhatsApp Flow'
      AND flow.status <> 'archived'
      AND flow.trigger_type = 'keyword'
      AND flow.entry_node_id = 'start'
      AND EXISTS (
        SELECT 1
        FROM public.flow_nodes AS welcome
        WHERE welcome.flow_id = flow.id
          AND welcome.node_key = 'welcome'
          AND welcome.node_type = 'send_buttons'
          AND welcome.config->'buttons' @> '[{"reply_id":"domestic"}]'::jsonb
          AND welcome.config->'buttons' @> '[{"reply_id":"international"}]'::jsonb
      )
      AND EXISTS (
        SELECT 1
        FROM public.flow_nodes AS destination
        WHERE destination.flow_id = flow.id
          AND destination.node_key = 'domestic_destination'
          AND destination.node_type = 'collect_input'
          AND destination.config->>'var_key' = 'destination'
          AND nullif(destination.config->>'next_node_key', '') IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM public.flow_nodes AS destination
        WHERE destination.flow_id = flow.id
          AND destination.node_key = 'international_destination'
          AND destination.node_type = 'collect_input'
          AND destination.config->>'var_key' = 'destination'
      )
  LOOP
    SELECT destination.config->>'next_node_key'
      INTO next_question_key
      FROM public.flow_nodes AS destination
     WHERE destination.flow_id = travel_flow.id
       AND destination.node_key = 'domestic_destination';

    IF NOT EXISTS (
      SELECT 1
      FROM public.flow_nodes AS question
      WHERE question.flow_id = travel_flow.id
        AND question.node_key = next_question_key
    ) THEN
      RAISE WARNING
        'Skipping Travel Enquiry WhatsApp Flow %: the existing destination question has no valid next node.',
        travel_flow.id;
      CONTINUE;
    END IF;

    UPDATE public.flow_nodes AS welcome
       SET config = jsonb_set(
         welcome.config,
         '{buttons}',
         (
           SELECT jsonb_agg(
             CASE button.value->>'reply_id'
               WHEN 'domestic' THEN jsonb_build_object(
                 'reply_id', 'domestic',
                 'title', coalesce(button.value->>'title', 'Domestic'),
                 'next_node_key', 'domestic_destination',
                 'set_vars', jsonb_build_object(
                   'destination_scope', 'domestic',
                   'destination_page', '0'
                 )
               )
               WHEN 'international' THEN jsonb_build_object(
                 'reply_id', 'international',
                 'title', coalesce(button.value->>'title', 'International'),
                 'next_node_key', 'domestic_destination',
                 'set_vars', jsonb_build_object(
                   'destination_scope', 'international',
                   'destination_page', '0'
                 )
               )
               ELSE button.value
             END
             ORDER BY button.ordinality
           )
           FROM jsonb_array_elements(welcome.config->'buttons')
             WITH ORDINALITY AS button(value, ordinality)
         ),
         false
       )
     WHERE welcome.flow_id = travel_flow.id
       AND welcome.node_key = 'welcome';

    UPDATE public.flow_nodes AS picker
       SET node_type = 'send_list',
           config = jsonb_build_object(
             'text', 'Choose a destination:',
             'button_label', 'View destinations',
             'dynamic_destinations', true,
             'destination_scope_var', 'destination_scope',
             'selection_next_node_key', next_question_key,
             'sections', jsonb_build_array(
               jsonb_build_object(
                 'title', 'Destinations',
                 'rows', jsonb_build_array(
                   jsonb_build_object(
                     'reply_id', 'destination:template-placeholder',
                     'title', 'Destination',
                     'next_node_key', next_question_key
                   )
                 )
               )
             )
           )
     WHERE picker.flow_id = travel_flow.id
       AND picker.node_key = 'domestic_destination'
       AND picker.node_type = 'collect_input';

    DELETE FROM public.flow_nodes AS obsolete
     WHERE obsolete.flow_id = travel_flow.id
       AND obsolete.node_key = 'international_destination'
       AND obsolete.node_type = 'collect_input'
       AND travel_flow.entry_node_id <> obsolete.node_key
       AND NOT EXISTS (
         SELECT 1
         FROM public.flow_nodes AS other_node
         WHERE other_node.flow_id = travel_flow.id
           AND other_node.id <> obsolete.id
           AND other_node.config::text LIKE
             '%"next_node_key":"' || obsolete.node_key || '"%'
       );

    UPDATE public.flows AS flow
       SET description =
             'Collect a travel enquiry using live destination choices and destination PDFs from Travel CRM.',
           updated_at = now()
     WHERE flow.id = travel_flow.id;

    migrated_count := migrated_count + 1;
  END LOOP;

  RAISE NOTICE
    'Adapted % existing Travel Enquiry WhatsApp Flow record(s); no new flows were created.',
    migrated_count;
END;
$$;

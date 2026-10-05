ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'travel_crm_get_destinations',
    'travel_crm_get_destination',
    'travel_crm_complete_enquiry',
    'handoff',
    'http_fetch',
    'end'
  ));

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// ============================================================
// Fakes for the interpolation tests at the bottom of this file
// (issue #553). Same shape as dispatch.test.ts: a minimal Supabase
// query-builder stand-in plus a stubbed meta-send, so we can drive the
// real `dispatchInboundToFlows` and assert on the payload that would
// have gone to Meta. vi.mock is hoisted above the imports below, so
// the pure-helper tests are unaffected — they never touch either.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rows loadActiveRunForContact sees. */
    activeRuns: [] as Record<string, unknown>[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    contacts: [] as unknown[],
    /** flow_run_events INSERTs (what logEvent wrote). */
    events: [] as Record<string, unknown>[],
    /** Every UPDATE, by table. */
    updates: [] as { table: string; row: Record<string, unknown> }[],
    destinations: [] as import('./travel-destinations').TravelDestination[],
    destinationLookupError: null as Error | null,
  },
  sendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid.text' })),
  sendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.pdf' })),
  fetchDestinations: vi.fn(async () => {
    if (h.state.destinationLookupError) throw h.state.destinationLookupError;
    return h.state.destinations;
  }),
  sendButtons: vi.fn<
    (
      args: Parameters<typeof engineSendInteractiveButtons>[0]
    ) => Promise<{ whatsapp_message_id: string }>
  >(async () => ({ whatsapp_message_id: 'wamid.3' })),
  sendList: vi.fn<
    (
      args: Parameters<typeof engineSendInteractiveList>[0]
    ) => Promise<{ whatsapp_message_id: string }>
  >(async () => ({ whatsapp_message_id: 'wamid.4' })),
}));

vi.mock('./admin-client', () => {
  function rows(table: string): unknown[] {
    if (table === 'flow_runs') return h.state.activeRuns;
    if (table === 'flows') return h.state.flows;
    if (table === 'flow_nodes') return h.state.nodes;
    if (table === 'contacts') return h.state.contacts;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        h.state.updates.push({ table, row });
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === 'flow_run_events') h.state.events.push(row);
        return b;
      },
      maybeSingle: async () => ({ data: rows(table)[0] ?? null, error: null }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: { data: unknown[]; error: null; count: number }) => unknown
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: h.sendText,
  engineSendMedia: h.sendMedia,
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: h.sendList,
}));

vi.mock('./travel-destinations', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./travel-destinations')>();
  return { ...original, fetchTravelDestinations: h.fetchDestinations };
});

import {
  dispatchInboundToFlows,
  dynamicListPage,
  getDynamicListOptions,
  interpolateVars,
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  isValidNumericInput,
  isValidDateInput,
} from './engine';
import type {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from './meta-send';
import type { FlowRunRow, ParsedInbound, SendListNodeConfig } from './types';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('dynamic send-list helpers', () => {
  it('maps display fields and reply IDs from the configured flow variable array', () => {
    const options = getDynamicListOptions(
      {
        vars: {
          destinations: [
            {
              destination_id: 'dest-1',
              destination_name: 'Goa',
              assigned_employee_id: 'employee-1',
            },
          ],
        },
      } as unknown as FlowRunRow,
      {
        dynamic_source_var: 'destinations',
        dynamic_title_field: 'destination_name',
        dynamic_reply_id_field: 'destination_id',
        dynamic_section_title: 'Destinations',
        dynamic_assigned_employee_id_field: 'assigned_employee_id',
      } as SendListNodeConfig
    );
    expect(options).toMatchObject([
      {
        id: 'dest-1',
        title: 'Goa',
        item: {
          assigned_employee_id: 'employee-1',
        },
      },
    ]);
  });

  it('adds the configured None choice even when the source array is empty', () => {
    const options = getDynamicListOptions(
      { vars: { destinations: [] } } as unknown as FlowRunRow,
      {
        dynamic_source_var: 'destinations',
        dynamic_title_field: 'destination_name',
        dynamic_reply_id_field: 'destination_id',
        include_none_option: true,
        none_option_title: 'No preference',
      } as SendListNodeConfig
    );
    expect(options).toEqual([
      {
        id: '__flow_dynamic_none__',
        title: 'No preference',
        item: {},
        isNone: true,
      },
    ]);
    expect(dynamicListPage(options, 0).rows).toEqual([
      {
        id: '__flow_dynamic_option__:__flow_dynamic_none__',
        title: 'No preference',
      },
    ]);
  });

  it('pages dynamic options into WhatsApp list limits and preserves nested values for interpolation', () => {
    const options = Array.from({ length: 19 }, (_, index) => ({
      id: `id-${index}`,
      title: `Destination ${index}`,
      item: {},
    }));
    const pages = [0, 1, 2].map((page) => dynamicListPage(options, page));
    expect(pages.every((page) => page.rows.length <= 10)).toBe(true);
    expect(pages.flatMap((page) => page.rows).filter((row) =>
      row.id.startsWith('__flow_dynamic_option__:'),
    )).toHaveLength(19);
    expect(
      interpolateVars('PDF {{vars.destination.pdf_url}}', {
        destination: { pdf_url: 'https://example.com/goa.pdf' },
      })
    ).toBe('PDF https://example.com/goa.pdf');
  });
});

describe('matchReplyId', () => {
  it('returns null for nodes without options', () => {
    expect(
      matchReplyId({ node_type: 'start', config: { next_node_key: 'x' } }, 'y')
    ).toBeNull();
    expect(
      matchReplyId({ node_type: 'send_message', config: {} }, 'y')
    ).toBeNull();
    expect(matchReplyId({ node_type: 'end', config: {} }, 'y')).toBeNull();
  });

  it('matches the buttons array on a send_buttons node', () => {
    const node = {
      node_type: 'send_buttons',
      config: {
        text: 'Pick one',
        buttons: [
          { reply_id: 'yes', title: 'Yes', next_node_key: 'confirmed' },
          { reply_id: 'no', title: 'No', next_node_key: 'declined' },
        ],
      },
    };
    expect(matchReplyId(node, 'yes')).toBe('confirmed');
    expect(matchReplyId(node, 'no')).toBe('declined');
  });

  it('returns null when no button reply_id matches', () => {
    const node = {
      node_type: 'send_buttons',
      config: {
        text: 'Pick',
        buttons: [
          { reply_id: 'a', title: 'A', next_node_key: 'to_a' },
          { reply_id: 'b', title: 'B', next_node_key: 'to_b' },
        ],
      },
    };
    expect(matchReplyId(node, 'c')).toBeNull();
    expect(matchReplyId(node, '')).toBeNull();
  });

  it('searches across all sections in a send_list node', () => {
    const node = {
      node_type: 'send_list',
      config: {
        text: 'Pick an order',
        button_label: 'View',
        sections: [
          {
            title: 'Recent',
            rows: [
              { reply_id: 'o1', title: 'Order 1', next_node_key: 'ord_1' },
            ],
          },
          {
            title: 'Older',
            rows: [
              { reply_id: 'o2', title: 'Order 2', next_node_key: 'ord_2' },
              { reply_id: 'o3', title: 'Order 3', next_node_key: 'ord_3' },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, 'o1')).toBe('ord_1');
    expect(matchReplyId(node, 'o2')).toBe('ord_2');
    expect(matchReplyId(node, 'o3')).toBe('ord_3');
    expect(matchReplyId(node, 'o99')).toBeNull();
  });

  it('returns null when send_list has no sections / empty sections', () => {
    expect(
      matchReplyId(
        { node_type: 'send_list', config: { text: 'x', sections: [] } },
        'x'
      )
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: 'send_list',
          config: { text: 'x', sections: [{ rows: [] }] },
        },
        'x'
      )
    ).toBeNull();
  });
});

describe('matchesKeywordTrigger', () => {
  it('returns false for empty text', () => {
    expect(matchesKeywordTrigger('', { keywords: ['hi'] })).toBe(false);
  });

  describe('isValidNumericInput', () => {
    it('accepts only safe whole-number text within inclusive bounds', () => {
      expect(isValidNumericInput('2', { min_value: 1 })).toBe(true);
      expect(isValidNumericInput('0', { min_value: 0, max_value: 5 })).toBe(
        true
      );
      expect(isValidNumericInput('6', { min_value: 0, max_value: 5 })).toBe(
        false
      );
      expect(isValidNumericInput('0', { min_value: 1 })).toBe(false);
      expect(isValidNumericInput('2.5', { min_value: 0 })).toBe(false);
      expect(isValidNumericInput('two', { min_value: 0 })).toBe(false);
      expect(isValidNumericInput('9007199254740992', { min_value: 0 })).toBe(
        false
      );
    });

    });

    describe('isValidDateInput', () => {
      it('accepts only real dates in DD-MM-YYYY format', () => {
        expect(isValidDateInput('29-02-2024')).toBe(true);
        expect(isValidDateInput('31-12-2026')).toBe(true);
        expect(isValidDateInput('29-02-2025')).toBe(false);
        expect(isValidDateInput('31-04-2026')).toBe(false);
        expect(isValidDateInput('2026-12-31')).toBe(false);
        expect(isValidDateInput('1-12-2026')).toBe(false);
      });
    });

  it('returns false when keywords array is empty', () => {
    expect(matchesKeywordTrigger('anything', { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ['support'] };
    expect(matchesKeywordTrigger('I need SUPPORT please', cfg)).toBe(true);
    expect(matchesKeywordTrigger('Support is great', cfg)).toBe(true);
    expect(matchesKeywordTrigger('Help me', cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ['help'], match_type: 'exact' as const };
    expect(matchesKeywordTrigger('help', cfg)).toBe(true);
    expect(matchesKeywordTrigger('HELP', cfg)).toBe(true);
    expect(matchesKeywordTrigger('help me', cfg)).toBe(false);
  });

  it('case_sensitive=true preserves case', () => {
    const cfg = {
      keywords: ['Support'],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger('I need Support', cfg)).toBe(true);
    expect(matchesKeywordTrigger('I need support', cfg)).toBe(false);
  });

  it('matches any one of multiple keywords', () => {
    const cfg = { keywords: ['help', 'support', 'issue'] };
    expect(matchesKeywordTrigger('I have an issue', cfg)).toBe(true);
    expect(matchesKeywordTrigger('I need Help!', cfg)).toBe(true);
    expect(matchesKeywordTrigger('nothing to see here', cfg)).toBe(false);
  });

  it('skips empty strings in the keywords array', () => {
    const cfg = { keywords: ['', 'support', ''] };
    expect(matchesKeywordTrigger('support center', cfg)).toBe(true);
    expect(matchesKeywordTrigger('nope', cfg)).toBe(false);
  });
});

describe('node classification helpers', () => {
  it('isAutoAdvancing covers start + send_message + send_media + condition + set_tag', () => {
    expect(isAutoAdvancing('start')).toBe(true);
    expect(isAutoAdvancing('send_message')).toBe(true);
    expect(isAutoAdvancing('send_media')).toBe(true);
    expect(isAutoAdvancing('travel_crm_get_destinations')).toBe(true);
    expect(isAutoAdvancing('travel_crm_get_destination')).toBe(true);
    expect(isAutoAdvancing('travel_crm_complete_enquiry')).toBe(true);
    expect(isAutoAdvancing('condition')).toBe(true);
    expect(isAutoAdvancing('set_tag')).toBe(true);
    expect(isAutoAdvancing('send_buttons')).toBe(false);
    expect(isAutoAdvancing('send_list')).toBe(false);
    expect(isAutoAdvancing('collect_input')).toBe(false);
    expect(isAutoAdvancing('handoff')).toBe(false);
    expect(isAutoAdvancing('end')).toBe(false);
  });

  it('isSuspending covers the input-requiring nodes', () => {
    expect(isSuspending('send_buttons')).toBe(true);
    expect(isSuspending('send_list')).toBe(true);
    expect(isSuspending('collect_input')).toBe(true);
    expect(isSuspending('start')).toBe(false);
    expect(isSuspending('send_message')).toBe(false);
    expect(isSuspending('condition')).toBe(false);
    expect(isSuspending('set_tag')).toBe(false);
    expect(isSuspending('handoff')).toBe(false);
    expect(isSuspending('end')).toBe(false);
  });

  it('isTerminal covers handoff + end', () => {
    expect(isTerminal('handoff')).toBe(true);
    expect(isTerminal('end')).toBe(true);
    expect(isTerminal('start')).toBe(false);
    expect(isTerminal('send_buttons')).toBe(false);
    expect(isTerminal('condition')).toBe(false);
  });

  it('the three classifications are mutually exclusive for known node types', () => {
    const types = [
      'start',
      'send_message',
      'send_buttons',
      'send_list',
      'send_media',
      'collect_input',
      'condition',
      'set_tag',
      'travel_crm_get_destinations',
      'travel_crm_get_destination',
      'travel_crm_complete_enquiry',
      'handoff',
      'end',
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe('evaluateConditionPredicate', () => {
  it('present: true when subject has a value', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: 'alice@example.com',
        configValue: undefined,
      })
    ).toBe(true);
  });

  it('present: false when subject is undefined or empty', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: undefined,
        configValue: undefined,
      })
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: '',
        configValue: undefined,
      })
    ).toBe(false);
  });

  it('absent: inverse of present', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'absent',
        subjectValue: undefined,
        configValue: undefined,
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'absent',
        subjectValue: 'x',
        configValue: undefined,
      })
    ).toBe(false);
  });

  it('equals: exact string comparison; case-sensitive', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: 'VIP',
        configValue: 'VIP',
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: 'vip',
        configValue: 'VIP',
      })
    ).toBe(false);
  });

  it('equals: undefined subject never matches (even against empty)', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: undefined,
        configValue: '',
      })
    ).toBe(false);
  });

  it('contains: substring match', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: 'support@example.com',
        configValue: '@example.com',
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: 'support@other.com',
        configValue: '@example.com',
      })
    ).toBe(false);
  });

  it('contains: undefined subject never matches', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: undefined,
        configValue: 'anything',
      })
    ).toBe(false);
  });
});

// ============================================================
// {{vars.*}} interpolation in send_buttons / send_list (issue #553).
//
// A send_buttons node placed after a collect_input used to send
// "Hi {{vars.name}}" literally — only send_message, send_media
// captions and collect_input prompts were interpolated.
// ============================================================

const RUN = {
  id: 'run-1',
  flow_id: 'flow-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  contact_id: 'ct-1',
  conversation_id: 'cv-1',
  status: 'active',
  current_node_key: 'ask_name',
  last_prompt_message_id: null,
  vars: {} as Record<string, unknown>,
  reprompt_count: 0,
  started_at: '2026-01-01T00:00:00Z',
  last_advanced_at: '2026-01-01T00:00:00Z',
  ended_at: null,
  end_reason: null,
};

const FLOW = {
  id: 'flow-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  status: 'active',
  trigger_type: 'manual',
  trigger_config: {},
  entry_node_id: 'ask_name',
  fallback_policy: {
    on_unknown_reply: 'reprompt',
    max_reprompts: 2,
    on_timeout_hours: 24,
    on_exhaust: 'handoff',
  },
  created_at: '2026-01-01T00:00:00Z',
};

const BUTTONS_NODE = {
  id: 'n2',
  flow_id: 'flow-1',
  node_key: 'choose',
  node_type: 'send_buttons',
  config: {
    text: 'Hi {{vars.name}}, please choose an option.',
    header_text: 'Welcome {{vars.name}}',
    // footer_text deliberately absent — must stay absent, not become "".
    buttons: [
      { reply_id: 'yes', title: 'Yes, {{vars.name}}', next_node_key: 'done' },
      // A reply_id is a routing key, not customer-visible text; it must
      // reach Meta exactly as authored even if it happens to look like a
      // template.
      {
        reply_id: 'no_{{vars.name}}',
        title: 'No thanks',
        next_node_key: 'done',
      },
    ],
  },
};

const LIST_NODE = {
  id: 'n3',
  flow_id: 'flow-1',
  node_key: 'pick',
  node_type: 'send_list',
  config: {
    text: '{{vars.name}}, pick a plan.',
    button_label: "{{vars.name}}'s plans",
    footer_text: 'Prices for {{vars.name}}',
    // header_text deliberately absent.
    sections: [
      {
        title: 'Plans for {{vars.name}}',
        rows: [
          {
            reply_id: 'basic',
            title: 'Basic for {{vars.name}}',
            description: 'Best for {{vars.name}}',
            next_node_key: 'done',
          },
          // No description — must stay absent.
          { reply_id: 'pro', title: 'Pro', next_node_key: 'done' },
        ],
      },
    ],
  },
};

/** collect_input "ask_name" → `next`, plus both interactive nodes + end. */
function nodesEndingIn(next: 'choose' | 'pick') {
  return [
    {
      id: 'n1',
      flow_id: 'flow-1',
      node_key: 'ask_name',
      node_type: 'collect_input',
      config: {
        prompt_text: "What's your name?",
        var_key: 'name',
        next_node_key: next,
      },
    },
    BUTTONS_NODE,
    LIST_NODE,
    {
      id: 'n9',
      flow_id: 'flow-1',
      node_key: 'done',
      node_type: 'end',
      config: {},
    },
  ];
}

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message,
    isFirstInboundMessage: false,
  });
}

function text(t: string): ParsedInbound {
  return { kind: 'text', text: t, meta_message_id: `m-${t}` };
}

describe('send_buttons / send_list interpolate {{vars.*}} (#553)', () => {
  beforeEach(() => {
    h.state.activeRuns = [{ ...RUN, vars: {} }];
    h.state.flows = [FLOW];
    h.state.nodes = nodesEndingIn('choose');
    h.state.events = [];
    h.state.updates = [];
  });

  describe('collect_input validation reprompts', () => {
    beforeEach(() => {
      h.state.activeRuns = [
        { ...RUN, current_node_key: 'ask_travel_date', vars: {} },
      ];
      h.state.flows = [FLOW];
      h.state.nodes = [
        {
          id: 'n-date',
          flow_id: 'flow-1',
          node_key: 'ask_travel_date',
          node_type: 'collect_input',
          config: {
            prompt_text: 'When are you planning to travel?',
            var_key: 'travel_date',
            validation: 'date',
            invalid_input_message:
              'Please enter the date in DD-MM-YYYY format. When are you planning to travel? Please reply in DD-MM-YYYY format.',
            next_node_key: 'done',
          },
        },
        { id: 'n-done', flow_id: 'flow-1', node_key: 'done', node_type: 'end', config: {} },
      ];
      h.state.events = [];
      h.state.updates = [];
      h.sendText.mockClear();
    });

    it('repeats the date question for invalid input without advancing or exhausting retries', async () => {
      const result = await dispatch(text('tomorrow'));

      expect(result).toMatchObject({ consumed: true, outcome: 'fallback_fired' });
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Please enter the date in DD-MM-YYYY format. When are you planning to travel? Please reply in DD-MM-YYYY format.',
        })
      );
      expect(h.state.updates).not.toContainEqual(
        expect.objectContaining({
          table: 'flow_runs',
          row: expect.objectContaining({ current_node_key: 'done' }),
        })
      );
      expect(h.state.events).toContainEqual(
        expect.objectContaining({
          event_type: 'fallback_fired',
          payload: expect.objectContaining({ action: 'validation_reprompt', validation: 'date' }),
        })
      );
    });

    it('accepts a valid date and advances', async () => {
      const result = await dispatch(text('25-12-2026'));

      expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
      expect(h.state.updates).toContainEqual(
        expect.objectContaining({
          table: 'flow_runs',
          row: expect.objectContaining({
            vars: expect.objectContaining({ travel_date: '25-12-2026' }),
          }),
        })
      );
    });
  });

  it('send_buttons after collect_input renders body, header and button titles', async () => {
    const result = await dispatch(text('Alice'));

    expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
    expect(h.sendButtons).toHaveBeenCalledTimes(1);
    const args = h.sendButtons.mock.calls[0][0];
    expect(args.bodyText).toBe('Hi Alice, please choose an option.');
    expect(args.headerText).toBe('Welcome Alice');
    expect(args.footerText).toBeUndefined();
    expect(args.buttons).toEqual([
      { id: 'yes', title: 'Yes, Alice' },
      { id: 'no_{{vars.name}}', title: 'No thanks' },
    ]);
    // The run really suspended on the buttons node.
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: 'flow_runs',
        row: expect.objectContaining({ current_node_key: 'choose' }),
      })
    );
  });

  it('send_list after collect_input renders body, button label, footer, section and row text', async () => {
    h.state.nodes = nodesEndingIn('pick');

    const result = await dispatch(text('Alice'));

    expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
    expect(h.sendList).toHaveBeenCalledTimes(1);
    const args = h.sendList.mock.calls[0][0];
    expect(args.bodyText).toBe('Alice, pick a plan.');
    expect(args.buttonLabel).toBe("Alice's plans");
    expect(args.footerText).toBe('Prices for Alice');
    expect(args.headerText).toBeUndefined();
    expect(args.sections).toEqual([
      {
        title: 'Plans for Alice',
        rows: [
          {
            id: 'basic',
            title: 'Basic for Alice',
            description: 'Best for Alice',
          },
          { id: 'pro', title: 'Pro', description: undefined },
        ],
      },
    ]);
  });

  it('reprompt re-sends the interactive node with the same interpolation', async () => {
    // Run already suspended on the buttons node with the var captured;
    // the customer types instead of tapping → fallback → reprompt.
    h.state.activeRuns = [
      { ...RUN, current_node_key: 'choose', vars: { name: 'Alice' } },
    ];

    const result = await dispatch(text('huh?'));

    expect(result).toMatchObject({ consumed: true, outcome: 'fallback_fired' });
    expect(h.sendButtons).toHaveBeenCalledTimes(1);
    expect(h.sendButtons.mock.calls[0][0].bodyText).toBe(
      'Hi Alice, please choose an option.'
    );
    expect(h.sendButtons.mock.calls[0][0].buttons[0]).toEqual({
      id: 'yes',
      title: 'Yes, Alice',
    });
  });

  describe('dynamic travel destination flow', () => {
    const picker = {
      id: 'n-picker',
      flow_id: 'flow-1',
      node_key: 'destination_picker',
      node_type: 'send_list',
      config: {
        text: 'Choose a destination:',
        button_label: 'View destinations',
        dynamic_destinations: true,
        destination_scope_var: 'destination_scope',
        selection_next_node_key: 'ask_name',
        sections: [
          {
            title: 'Destinations',
            rows: [
              {
                reply_id: 'destination-placeholder',
                title: 'Destination',
                next_node_key: 'ask_name',
              },
            ],
          },
        ],
      },
    };
    const askName = {
      id: 'n-ask-name',
      flow_id: 'flow-1',
      node_key: 'ask_name',
      node_type: 'collect_input',
      config: {
        prompt_text: 'May I know your name?',
        var_key: 'name',
        next_node_key: 'done',
      },
    };
    const destination = {
      id: 'dest-1',
      name: 'Goa',
      scope: 'domestic' as const,
      pdf: {
        name: 'Goa.pdf',
        url: 'https://storage.example/signed/goa.pdf',
      },
      assignment_status: 'ambiguous' as const,
      assigned_employee_id: '11111111-1111-4111-8111-111111111111',
    };

    beforeEach(() => {
      h.state.activeRuns = [
        {
          ...RUN,
          current_node_key: 'destination_picker',
          vars: { destination_scope: 'domestic', destination_page: '0' },
        },
      ];
      h.state.flows = [FLOW];
      h.state.nodes = [
        picker,
        askName,
        {
          id: 'n-done',
          flow_id: 'flow-1',
          node_key: 'done',
          node_type: 'end',
          config: {},
        },
      ];
      h.state.events = [];
      h.state.updates = [];
      h.state.destinations = [destination];
      h.state.destinationLookupError = null;
      h.fetchDestinations.mockClear();
      h.sendText.mockClear();
      h.sendMedia.mockClear();
      h.sendList.mockClear();
    });

    it('captures destination identity and assignment metadata, sends its PDF before the next question', async () => {
      const result = await dispatch({
        kind: 'interactive_reply',
        reply_id: 'destination:dest-1',
        reply_title: 'Goa',
        meta_message_id: 'm-destination',
      });

      expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
      expect(h.state.updates).toContainEqual(
        expect.objectContaining({
          table: 'flow_runs',
          row: {
            vars: expect.objectContaining({
              destination: 'Goa',
              destination_id: 'dest-1',
              destination_scope: 'domestic',
              destination_assignment_status: 'ambiguous',
              destination_readiness: 'ambiguous',
              destination_selection: {
                id: 'dest-1',
                name: 'Goa',
                scope: 'domestic',
                assignment_status: 'ambiguous',
              },
            }),
          },
        })
      );
      expect(h.sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'document',
          link: destination.pdf.url,
          filename: 'Goa.pdf',
        })
      );
      expect(h.sendMedia.mock.invocationCallOrder[0]).toBeLessThan(
        h.sendText.mock.invocationCallOrder[0]
      );
    });

    it('continues the questions when the selected destination has no PDF', async () => {
      h.state.destinations = [{ ...destination, pdf: null }];

      const result = await dispatch({
        kind: 'interactive_reply',
        reply_id: 'destination:dest-1',
        reply_title: 'Goa',
        meta_message_id: 'm-no-pdf',
      });

      expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
      expect(h.sendMedia).not.toHaveBeenCalled();
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'May I know your name?' })
      );
    });

    it('hands off when a configured destination PDF cannot be sent', async () => {
      h.sendMedia.mockRejectedValueOnce(
        new Error('Meta rejected the document URL')
      );

      const result = await dispatch({
        kind: 'interactive_reply',
        reply_id: 'destination:dest-1',
        reply_title: 'Goa',
        meta_message_id: 'm-pdf-failed',
      });

      expect(result).toMatchObject({ consumed: true, outcome: 'handed_off' });
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(
            "couldn't send that destination's information"
          ),
        })
      );
      expect(h.sendText).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: 'May I know your name?' })
      );
    });

    it("paginates destinations beyond Meta's ten-row limit without dropping choices", async () => {
      h.state.destinations = Array.from({ length: 23 }, (_, index) => ({
        ...destination,
        id: `dest-${index + 1}`,
        name: `Destination ${index + 1}`,
        pdf: null,
      }));

      const result = await dispatch({
        kind: 'interactive_reply',
        reply_id: 'destination:next',
        reply_title: 'Next page',
        meta_message_id: 'm-next-page',
      });

      expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
      const rows = h.sendList.mock.calls[0][0].sections[0].rows;
      expect(rows).toHaveLength(10);
      expect(rows.map((row) => row.id)).toContain('destination:previous');
      expect(rows.map((row) => row.id)).toContain('destination:next');
      expect(rows[0].id).toBe('destination:dest-9');
    });

    it('visibly hands off rather than inventing choices after lookup failure', async () => {
      h.state.destinationLookupError = new Error('lookup offline');

      const result = await dispatch({
        kind: 'interactive_reply',
        reply_id: 'destination:dest-1',
        reply_title: 'Goa',
        meta_message_id: 'm-lookup-failed',
      });

      expect(result).toMatchObject({ consumed: true, outcome: 'handed_off' });
      expect(h.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('unable to load destinations'),
        })
      );
      expect(h.state.updates).toContainEqual(
        expect.objectContaining({
          table: 'flow_runs',
          row: expect.objectContaining({ status: 'handed_off' }),
        })
      );
    });
  });

  it("a send failure (e.g. an interpolated title over Meta's limit) is logged and fails the run", async () => {
    // "Yes, Bartholomew Montgomery" is 27 chars; meta-api's validator
    // rejects titles over INTERACTIVE_LIMITS.buttonTitleMaxLength (20)
    // before calling Meta. The stub stands in for that throw.
    h.sendButtons.mockRejectedValueOnce(
      new Error(
        'Interactive button title "Yes, Bartholomew Montgomery" exceeds 20 chars.'
      )
    );

    const result = await dispatch(text('Bartholomew Montgomery'));

    // Previously the throw escaped to dispatchInboundToFlows' catch:
    // consumed:false, nothing in flow_run_events, run left active.
    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: 'error',
        node_key: 'choose',
        payload: {
          reason: 'send_buttons_failed',
          detail: expect.stringContaining('exceeds 20 chars'),
        },
      })
    );
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: 'flow_runs',
        row: expect.objectContaining({
          status: 'failed',
          end_reason: 'send_buttons_failed',
        }),
      })
    );
  });
});

describe('visual Travel CRM actions in the flow engine', () => {
  beforeEach(() => {
    h.state.activeRuns = [
      {
        ...RUN,
        current_node_key: 'menu',
        vars: { travel_type: 'domestic' },
      },
    ];
    h.state.nodes = [
      {
        id: 'n-menu',
        flow_id: 'flow-1',
        node_key: 'menu',
        node_type: 'send_buttons',
        config: {
          text: 'Continue?',
          buttons: [{ reply_id: 'go', title: 'Go', next_node_key: 'lookup' }],
        },
      },
      {
        id: 'n-lookup',
        flow_id: 'flow-1',
        node_key: 'lookup',
        node_type: 'travel_crm_get_destinations',
        config: {
          travel_type: 'domestic',
          result_var: 'destinations',
          error_var: 'travel_crm_error',
          success_next_node_key: 'choose',
          error_next_node_key: 'lookup_error',
        },
      },
      {
        id: 'n-choose',
        flow_id: 'flow-1',
        node_key: 'choose',
        node_type: 'send_list',
        config: {
          text: 'Choose a destination',
          button_label: 'View destinations',
          dynamic_source_var: 'destinations',
          dynamic_title_field: 'destination_name',
          dynamic_reply_id_field: 'destination_id',
          dynamic_section_title: 'Destinations',
          dynamic_assigned_employee_id_field: 'assigned_employee_id',
          dynamic_next_node_key: 'details',
          selected_id_var: 'selected_destination_id',
          selected_title_var: 'selected_destination_name',
          selected_item_var: 'selected_destination',
          selected_assigned_employee_id_var: 'selected_assigned_employee_id',
        },
      },
      {
        id: 'n-details',
        flow_id: 'flow-1',
        node_key: 'details',
        node_type: 'end',
        config: {},
      },
      {
        id: 'n-error',
        flow_id: 'flow-1',
        node_key: 'lookup_error',
        node_type: 'send_message',
        config: {
          text: 'Lookup failed: {{vars.travel_crm_error}}',
          next_node_key: 'failed_end',
        },
      },
      {
        id: 'n-failed-end',
        flow_id: 'flow-1',
        node_key: 'failed_end',
        node_type: 'end',
        config: {},
      },
    ];
    h.state.destinations = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Goa',
        scope: 'domestic',
        pdf: null,
        assignment_status: 'assigned',
        assigned_employee_id: '11111111-1111-4111-8111-111111111111',
      },
    ];
    h.state.destinationLookupError = null;
    h.state.events = [];
    h.state.updates = [];
    h.fetchDestinations.mockClear();
    h.sendText.mockClear();
    h.sendList.mockClear();
  });

  it('loads CRM data and sends a dynamic list with CRM IDs as reply IDs', async () => {
    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: 'go',
      reply_title: 'Go',
      meta_message_id: 'm-travel-crm-success',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'advanced' });
    expect(h.fetchDestinations).toHaveBeenCalledWith('domestic');
    expect(h.sendList).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: [
          {
            title: 'Destinations',
            rows: [
              {
                id: '__flow_dynamic_option__:00000000-0000-4000-8000-000000000001',
                title: 'Goa',
              },
            ],
          },
        ],
      })
    );
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: 'flow_runs',
        row: expect.objectContaining({
          vars: expect.objectContaining({
            destinations: [
              expect.objectContaining({
                destination_id: '00000000-0000-4000-8000-000000000001',
                assigned_employee_id: '11111111-1111-4111-8111-111111111111',
              }),
            ],
          }),
        }),
      })
    );
  });

  it('routes a destination lookup failure to its configured failure node', async () => {
    h.state.destinationLookupError = new Error('Travel CRM unavailable');

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: 'go',
      reply_title: 'Go',
      meta_message_id: 'm-travel-crm-error',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.sendList).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Lookup failed: Travel CRM unavailable',
      })
    );
  });

  it('stores the selected CRM destination and its assigned employee from the loaded list', async () => {
    const destination = {
      destination_id: '00000000-0000-4000-8000-000000000001',
      destination_name: 'Goa',
      travel_type: 'domestic',
      assigned_employee_id: '11111111-1111-4111-8111-111111111111',
      assignment_status: 'assigned',
      pdf_url: null,
      pdf_available: false,
    };
    h.state.activeRuns = [
      {
        ...RUN,
        current_node_key: 'choose',
        vars: {
          destinations: [destination],
          __travel_crm_destinations: [destination],
        },
      },
    ];
    h.state.nodes = [
      {
        id: 'n-choose',
        flow_id: 'flow-1',
        node_key: 'choose',
        node_type: 'send_list',
        config: {
          text: 'Choose',
          button_label: 'Destinations',
          dynamic_source_var: 'destinations',
          dynamic_title_field: 'destination_name',
          dynamic_reply_id_field: 'destination_id',
          dynamic_assigned_employee_id_field: 'assigned_employee_id',
          dynamic_next_node_key: 'selected',
          selected_id_var: 'selected_destination_id',
          selected_title_var: 'selected_destination_name',
          selected_item_var: 'selected_destination',
          selected_assigned_employee_id_var: 'selected_assigned_employee_id',
        },
      },
      {
        id: 'n-selected',
        flow_id: 'flow-1',
        node_key: 'selected',
        node_type: 'send_message',
        config: {
          text: '{{vars.selected_destination_name}}',
          next_node_key: 'done',
        },
      },
      { id: 'n-done', flow_id: 'flow-1', node_key: 'done', node_type: 'end', config: {} },
    ];

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: '__flow_dynamic_option__:00000000-0000-4000-8000-000000000001',
      reply_title: 'Goa',
      meta_message_id: 'm-dynamic-destination-selected',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Goa' })
    );
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: 'flow_runs',
        row: expect.objectContaining({
          vars: expect.objectContaining({
            selected_destination_id: destination.destination_id,
            selected_destination_name: 'Goa',
            selected_assigned_employee_id: destination.assigned_employee_id,
            __travel_crm_destination: destination,
          }),
        }),
      })
    );
  });

  it('routes None directly to the enquiry question and clears destination state', async () => {
    h.state.activeRuns = [
      {
        ...RUN,
        current_node_key: 'choose',
        vars: {
          destinations: [],
          selected_destination_id: 'old-destination-id',
          selected_destination_name: 'Old destination',
          selected_destination: { destination_id: 'old-destination-id' },
          selected_assigned_employee_id: 'old-employee-id',
          __travel_crm_destinations: [{ destination_id: 'old-destination-id' }],
          __travel_crm_destination: { destination_id: 'old-destination-id' },
        },
      },
    ];
    h.state.nodes = [
      {
        id: 'n-choose',
        flow_id: 'flow-1',
        node_key: 'choose',
        node_type: 'send_list',
        config: {
          text: 'Choose a destination',
          button_label: 'Destinations',
          dynamic_source_var: 'destinations',
          dynamic_title_field: 'destination_name',
          dynamic_reply_id_field: 'destination_id',
          include_none_option: true,
          none_next_node_key: 'ask-name',
          dynamic_next_node_key: 'destination-pdf',
        },
      },
      {
        id: 'n-pdf',
        flow_id: 'flow-1',
        node_key: 'destination-pdf',
        node_type: 'send_media',
        config: { media_type: 'document', media_url: 'https://example.com/destination.pdf' },
      },
      {
        id: 'n-name',
        flow_id: 'flow-1',
        node_key: 'ask-name',
        node_type: 'send_message',
        config: { text: 'What is your full name?', next_node_key: 'done' },
      },
      { id: 'n-done', flow_id: 'flow-1', node_key: 'done', node_type: 'end', config: {} },
    ];
    h.sendMedia.mockClear();
    h.sendText.mockClear();

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: '__flow_dynamic_option__:__flow_dynamic_none__',
      reply_title: 'None',
      meta_message_id: 'm-dynamic-destination-none',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'What is your full name?' })
    );
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: 'flow_runs',
        row: expect.objectContaining({
          vars: expect.objectContaining({
            selected_destination_id: null,
            selected_destination_name: null,
            selected_destination: null,
            selected_assigned_employee_id: null,
            __travel_crm_destination: null,
            __travel_crm_destination_none: true,
          }),
        }),
      })
    );
  });

  it('skips variable-backed media when the CRM returned no PDF URL', async () => {
    h.state.activeRuns = [
      {
        ...RUN,
        current_node_key: 'menu',
        vars: { destination: { pdf_url: null, pdf_available: false } },
      },
    ];
    h.state.nodes = [
      {
        id: 'n-menu',
        flow_id: 'flow-1',
        node_key: 'menu',
        node_type: 'send_buttons',
        config: {
          text: 'Continue?',
          buttons: [{ reply_id: 'go', title: 'Go', next_node_key: 'media' }],
        },
      },
      {
        id: 'n-media',
        flow_id: 'flow-1',
        node_key: 'media',
        node_type: 'send_media',
        config: {
          media_type: 'document',
          media_url: '{{vars.destination.pdf_url}}',
          next_node_key: 'after_media',
        },
      },
      {
        id: 'n-after-media',
        flow_id: 'flow-1',
        node_key: 'after_media',
        node_type: 'send_message',
        config: { text: 'Please provide your name.', next_node_key: 'done' },
      },
      { id: 'n-done', flow_id: 'flow-1', node_key: 'done', node_type: 'end', config: {} },
    ];
    h.sendMedia.mockClear();
    h.sendText.mockClear();

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: 'go',
      reply_title: 'Go',
      meta_message_id: 'm-no-travel-pdf',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Please provide your name.' })
    );
  });

  function setCompletionFlow() {
    h.state.activeRuns = [
      {
        ...RUN,
        flow_id: '66666666-6666-4666-8666-666666666666',
        contact_id: '77777777-7777-4777-8777-777777777777',
        conversation_id: '88888888-8888-4888-8888-888888888888',
        current_node_key: 'menu',
        vars: {
          customer_name: 'Sam',
          travel_date: '25-12-2026',
          adults: '2',
          children: '1',
          departure_city: 'Mumbai',
          budget: '50000',
          special_requirements: 'Vegetarian meals',
          destination: {
            destination_id: '00000000-0000-4000-8000-000000000001',
            destination_name: 'Goa',
            travel_type: 'domestic',
            assignment_status: 'assigned',
            assigned_employee_id: '11111111-1111-4111-8111-111111111111',
          },
          __travel_crm_destination: {
            destination_id: '00000000-0000-4000-8000-000000000001',
            destination_name: 'Goa',
            travel_type: 'domestic',
            assignment_status: 'assigned',
            assigned_employee_id: '11111111-1111-4111-8111-111111111111',
            pdf_url: null,
            pdf_available: false,
          },
        },
      },
    ];
    h.state.flows = [
      {
        ...FLOW,
        id: '66666666-6666-4666-8666-666666666666',
        name: 'Travel Enquiry',
      },
    ];
    h.state.contacts = [
      {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'WhatsApp Contact',
        phone: '+919876543210',
        email: null,
      },
    ];
    h.state.nodes = [
      {
        id: 'n-finish-menu',
        flow_id: 'flow-1',
        node_key: 'menu',
        node_type: 'send_buttons',
        config: {
          text: 'Complete your enquiry?',
          buttons: [
            { reply_id: 'finish', title: 'Finish', next_node_key: 'complete' },
          ],
        },
      },
      {
        id: 'n-complete',
        flow_id: 'flow-1',
        node_key: 'complete',
        node_type: 'travel_crm_complete_enquiry',
        config: {
          destination_var: 'destination',
          variable_map: {
            customer_name: 'customer_name',
            travel_date: 'travel_date',
            adults: 'adults',
            children: 'children',
            departure_city: 'departure_city',
            budget: 'budget',
            special_requirements: 'special_requirements',
          },
          result_var: 'crm_enquiry',
          error_var: 'travel_crm_error',
          success_next_node_key: 'thank_you',
          error_next_node_key: 'save_error',
        },
      },
      {
        id: 'n-thank-you',
        flow_id: 'flow-1',
        node_key: 'thank_you',
        node_type: 'send_message',
        config: {
          text: 'Saved {{vars.crm_enquiry.enquiry_number}}',
          next_node_key: 'done',
        },
      },
      {
        id: 'n-save-error',
        flow_id: 'flow-1',
        node_key: 'save_error',
        node_type: 'send_message',
        config: {
          text: 'We could not save your enquiry: {{vars.travel_crm_error}}',
          next_node_key: 'done',
        },
      },
      { id: 'n-done', flow_id: 'flow-1', node_key: 'done', node_type: 'end', config: {} },
    ];
    h.state.events = [];
    h.state.updates = [];
    h.sendText.mockClear();
  }

  it('creates the canonical CRM enquiry from collected variables and verified assignment', async () => {
    setCompletionFlow();
    vi.stubEnv(
      'TRAVEL_CRM_FLOW_SYNC_URL',
      'https://travel.example/api/wacrm/flow-completed'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', 'a-32-byte-or-longer-shared-bridge-secret');
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          customer_id: '22222222-2222-4222-8222-222222222222',
          lead_id: '33333333-3333-4333-8333-333333333333',
          enquiry_id: '44444444-4444-4444-8444-444444444444',
          enquiry_number: 'ENQ-0001',
        })
    );
    vi.stubGlobal('fetch', request);

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: 'finish',
      reply_title: 'Finish',
      meta_message_id: 'm-completion-success',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    const init = request.mock.calls[0]?.[1];
    if (!init) throw new Error('CRM completion request was not sent.');
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      is_partial: false,
      handoff_requested: false,
      destination: {
        id: '00000000-0000-4000-8000-000000000001',
        assigned_employee_id: '11111111-1111-4111-8111-111111111111',
      },
      answers: {
        customer_name: 'Sam',
        travel_date: '2026-12-25',
        adults: '2',
        children: '1',
        departure_city: 'Mumbai',
        budget: '50000',
        special_requirements: 'Vegetarian meals',
      },
    });
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Saved ENQ-0001' })
    );
  });

  it('saves a None-destination enquiry with blank destination fields and other answers intact', async () => {
    setCompletionFlow();
    const run = h.state.activeRuns[0] as unknown as FlowRunRow;
    run.vars = {
      ...run.vars,
      selected_destination_id: null,
      selected_destination_name: null,
      selected_destination: null,
      selected_assigned_employee_id: null,
      __travel_crm_destination_none: true,
    };
    const completionNode = h.state.nodes.find(
      (node) => (node as { node_key: string }).node_key === 'complete'
    ) as { config: Record<string, unknown> } | undefined;
    if (!completionNode) throw new Error('Completion node is missing.');
    completionNode.config = {
      ...completionNode.config,
      variable_map: {
        ...(completionNode.config as { variable_map: Record<string, string> }).variable_map,
        destination_id: 'selected_destination_id',
        destination_name: 'selected_destination_name',
        assigned_employee_id: 'selected_assigned_employee_id',
      },
    };
    vi.stubEnv(
      'TRAVEL_CRM_FLOW_SYNC_URL',
      'https://travel.example/api/wacrm/flow-completed'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', 'a-32-byte-or-longer-shared-bridge-secret');
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          customer_id: '22222222-2222-4222-8222-222222222222',
          lead_id: '33333333-3333-4333-8333-333333333333',
          enquiry_id: '44444444-4444-4444-8444-444444444444',
          enquiry_number: 'ENQ-0002',
        })
    );
    vi.stubGlobal('fetch', request);

    await dispatch({
      kind: 'interactive_reply',
      reply_id: 'finish',
      reply_title: 'Finish',
      meta_message_id: 'm-completion-no-destination',
    });

    const init = request.mock.calls[0]?.[1];
    if (!init) throw new Error('CRM completion request was not sent.');
    const payload = JSON.parse(String(init.body));
    expect(payload.destination).toBeNull();
    expect(payload.answers).toMatchObject({
      customer_name: 'Sam',
      travel_date: '2026-12-25',
      budget: '50000',
      destination_id: null,
      destination_name: null,
      assigned_employee_id: null,
    });
    expect(payload.answers).not.toHaveProperty('selected_destination');
    expect(payload.answers).not.toHaveProperty('selected_destination_name');
  });

  it('does not take the success path when CRM enquiry creation fails', async () => {
    setCompletionFlow();
    vi.stubEnv(
      'TRAVEL_CRM_FLOW_SYNC_URL',
      'https://travel.example/api/wacrm/flow-completed'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', 'a-32-byte-or-longer-shared-bridge-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('failure', { status: 500 }))
    );

    const result = await dispatch({
      kind: 'interactive_reply',
      reply_id: 'finish',
      reply_title: 'Finish',
      meta_message_id: 'm-completion-failure',
    });

    expect(result).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('We could not save your enquiry'),
      })
    );
    expect(h.sendText).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Saved ENQ-') })
    );
  });
});

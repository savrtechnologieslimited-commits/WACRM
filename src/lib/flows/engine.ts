/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from './admin-client';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './meta-send';
import { decideFallback, resolveFallbackPolicy } from './fallback';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { removeContactTag } from '@/lib/contacts/tag-write';
import {
  buildDestinationPage,
  fetchTravelDestinations,
  type TravelDestination,
} from './travel-destinations';
import {
  completeTravelCrmEnquiry,
  getTravelCrmDestination,
  getTravelCrmDestinations,
  type TravelCrmDestination,
  type TravelCrmEnquiryPayload,
} from './travel-crm-actions';
import {
  type CollectInputNodeConfig,
  type TravelCrmCompleteEnquiryNodeConfig,
  type TravelCrmGetDestinationNodeConfig,
  type TravelCrmGetDestinationsNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from './types';

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string
): string | null {
  if (node.node_type === 'send_buttons') {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === 'send_list') {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? 'contains';
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (
      matchType === 'exact' ? haystack === needle : haystack.includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

/** Validate the numeric-only collect_input mode without interpreting natural language. */
export function isValidNumericInput(
  value: string,
  config: Pick<CollectInputNodeConfig, 'min_value' | 'max_value'>
): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return false;
  if (config.min_value !== undefined && parsed < config.min_value) return false;
  if (config.max_value !== undefined && parsed > config.max_value) return false;
  return true;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === 'text') return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim())
  );
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === 'start' ||
    node_type === 'send_message' ||
    node_type === 'send_media' ||
    node_type === 'travel_crm_get_destinations' ||
    node_type === 'travel_crm_get_destination' ||
    node_type === 'travel_crm_complete_enquiry' ||
    node_type === 'condition' ||
    node_type === 'set_tag'
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === 'send_buttons' ||
    node_type === 'send_list' ||
    node_type === 'collect_input'
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === 'handoff' || node_type === 'end';
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig['operator'];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case 'present':
      return args.subjectValue !== undefined && args.subjectValue !== '';
    case 'absent':
      return args.subjectValue === undefined || args.subjectValue === '';
    case 'equals':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? '');
    case 'contains':
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? '');
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from('flow_runs')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('[flows] loadActiveRunForContact error:', error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from('flows')
    .select('*')
    .eq('id', flowId)
    .maybeSingle();
  if (error) {
    console.error('[flows] loadFlow error:', error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from('flow_nodes')
    .select('*')
    .eq('flow_id', flowId);
  if (error) {
    console.error('[flows] loadAllNodes error:', error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | 'started'
    | 'node_entered'
    | 'message_sent'
    | 'reply_received'
    | 'fallback_fired'
    | 'handoff'
    | 'timeout'
    | 'error'
    | 'completed',
  node_key: string | null,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from('flow_run_events').insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error('[flows] logEvent error:', error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from('flow_run_events')
    .select('id', { count: 'exact', head: true })
    .in('flow_run_id', runIds)
    .eq('event_type', 'reply_received')
    .filter('payload->>meta_message_id', 'eq', metaMessageId);
  return (count ?? 0) > 0;
}

type EntryFlowSelection =
  { kind: 'start'; flow: FlowRow } | { kind: 'already_handled' };

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  contactId: string,
  message: ParsedInbound,
  isFirstInbound: boolean
): Promise<EntryFlowSelection | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from('flows')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === 'keyword') {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        if (cfg.once_per_contact) {
          const { data: priorRuns, error: priorRunsError } = await db
            .from('flow_runs')
            .select('id')
            .eq('account_id', accountId)
            .eq('flow_id', flow.id)
            .eq('contact_id', contactId)
            .in('status', ['completed', 'handed_off', 'paused_by_agent'])
            .limit(1);
          if (priorRunsError) {
            console.error(
              '[flows] checking prior runs before restart failed:',
              priorRunsError.message
            );
            return { kind: 'already_handled' };
          }
          if (priorRuns?.length) return { kind: 'already_handled' };
        }
        return { kind: 'start', flow };
      }
    } else if (
      flow.trigger_type === 'first_inbound_message' &&
      isFirstInbound
    ) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return { kind: 'start', flow };
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<{ outcome: 'advanced'; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_buttons',
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();
  await db
    .from('flow_runs')
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq('id', run.id);
  return { outcome: 'advanced', node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<{ outcome: 'advanced'; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_list',
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();
  await db
    .from('flow_runs')
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq('id', run.id);
  return { outcome: 'advanced', node_key: node.node_key };
}

async function sendDestinationListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  destinations: TravelDestination[]
): Promise<void> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const pageValue = Number(run.vars.destination_page ?? 0);
  const { rows } = buildDestinationPage(destinations, pageValue);
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: [
      {
        title: 'Destinations',
        rows: rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
        })),
      },
    ],
  });
  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_list',
    dynamic_destinations: true,
    row_count: rows.length,
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();
  await db
    .from('flow_runs')
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq('id', run.id);
}

export interface DynamicListOption {
  id: string;
  title: string;
  description?: string;
  item: Record<string, unknown>;
  isNone?: boolean;
}

const DYNAMIC_PAGE_SIZE = 8;
const DYNAMIC_PAGE_NEXT = '__flow_dynamic_page__:next';
const DYNAMIC_PAGE_PREVIOUS = '__flow_dynamic_page__:previous';
const DYNAMIC_NONE_OPTION_ID = '__flow_dynamic_none__';

export function getDynamicListOptions(
  run: FlowRunRow,
  cfg: SendListNodeConfig
): DynamicListOption[] {
  const source = cfg.dynamic_source_var
    ? resolveVariablePath(run.vars, cfg.dynamic_source_var)
    : undefined;
  if (!Array.isArray(source)) {
    throw new Error(
      `Dynamic list source "${cfg.dynamic_source_var ?? ''}" is not an array.`
    );
  }
  if (!cfg.dynamic_title_field?.trim() || !cfg.dynamic_reply_id_field?.trim()) {
    throw new Error('Dynamic list title and reply ID fields are required.');
  }

  const options = source.map((value, index): DynamicListOption => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Dynamic list item ${index + 1} is invalid.`);
    }
    const item = value as Record<string, unknown>;
    const rawId = resolveVariablePath(item, cfg.dynamic_reply_id_field!);
    const rawTitle = resolveVariablePath(item, cfg.dynamic_title_field!);
    const rawDescription = cfg.dynamic_description_field
      ? resolveVariablePath(item, cfg.dynamic_description_field)
      : undefined;
    const id =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : '';
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!id || id.length > 150 || !title) {
      throw new Error(`Dynamic list item ${index + 1} has no valid ID or title.`);
    }
    if (
      rawDescription !== undefined &&
      rawDescription !== null &&
      typeof rawDescription !== 'string'
    ) {
      throw new Error(`Dynamic list item ${index + 1} has an invalid description.`);
    }
    return {
      id,
      title: title.slice(0, 24),
      ...(typeof rawDescription === 'string' && rawDescription.trim()
        ? { description: rawDescription.trim().slice(0, 72) }
        : {}),
      item,
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error('Dynamic list source contains duplicate reply IDs.');
  }
  if (cfg.include_none_option) {
    if (options.some((option) => option.id === DYNAMIC_NONE_OPTION_ID)) {
      throw new Error('Dynamic list source contains a reserved reply ID.');
    }
    options.push({
      id: DYNAMIC_NONE_OPTION_ID,
      title: (cfg.none_option_title || 'None').trim().slice(0, 24) || 'None',
      item: {},
      isNone: true,
    });
  }
  if (options.length === 0) {
    throw new Error('Dynamic list source contains no options.');
  }
  return options;
}

export function dynamicListPage(
  options: DynamicListOption[],
  requestedPage: number
): { rows: Array<{ id: string; title: string; description?: string }>; page: number } {
  const pageSize = options.length > 10 ? DYNAMIC_PAGE_SIZE : 10;
  const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
  const page = Math.min(Math.max(Math.floor(requestedPage) || 0, 0), pageCount - 1);
  const start = page * pageSize;
  const rows = options.slice(start, start + pageSize).map((option) => ({
    id: `__flow_dynamic_option__:${option.id}`,
    title: option.title,
    ...(option.description ? { description: option.description } : {}),
  }));
  if (page > 0) rows.push({ id: DYNAMIC_PAGE_PREVIOUS, title: 'Previous page' });
  if (page < pageCount - 1) rows.push({ id: DYNAMIC_PAGE_NEXT, title: 'Next page' });
  return { rows, page };
}

async function sendDynamicListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<void> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const options = getDynamicListOptions(run, cfg);
  const pageKey = cfg.dynamic_page_var || `${cfg.dynamic_source_var}_page`;
  const requestedPage = Number(run.vars[pageKey] ?? 0);
  const { rows, page } = dynamicListPage(options, requestedPage);
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: [
      {
        title: cfg.dynamic_section_title || 'Options',
        rows,
      },
    ],
  });
  await logEvent(db, run.id, 'message_sent', node.node_key, {
    node_type: 'send_list',
    dynamic_source_var: cfg.dynamic_source_var,
    row_count: rows.length,
    page,
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from('messages')
    .select('id')
    .eq('message_id', whatsapp_message_id)
    .maybeSingle();
  await db
    .from('flow_runs')
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq('id', run.id);
}

async function handleDynamicListReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  replyId: string
): Promise<{ kind: 'matched'; nextNodeKey: string } | { kind: 'unmatched' }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const options = getDynamicListOptions(run, cfg);
  const pageKey = cfg.dynamic_page_var || `${cfg.dynamic_source_var}_page`;
  const currentPage = Number(run.vars[pageKey] ?? 0);
  if (replyId === DYNAMIC_PAGE_NEXT || replyId === DYNAMIC_PAGE_PREVIOUS) {
    const pageSize = options.length > 10 ? DYNAMIC_PAGE_SIZE : 10;
    const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
    const nextPage = Math.min(
      Math.max(currentPage + (replyId === DYNAMIC_PAGE_NEXT ? 1 : -1), 0),
      pageCount - 1
    );
    if (nextPage === currentPage) return { kind: 'unmatched' };
    if (!(await persistRunVars(db, run, { ...run.vars, [pageKey]: nextPage }, node.node_key))) {
      return { kind: 'unmatched' };
    }
    return { kind: 'matched', nextNodeKey: node.node_key };
  }

  const prefix = '__flow_dynamic_option__:';
  if (!replyId.startsWith(prefix)) return { kind: 'unmatched' };
  const selected = options.find((option) => option.id === replyId.slice(prefix.length));
  if (!selected) return { kind: 'unmatched' };

  const selectedIdVar = cfg.selected_id_var || 'selected_destination_id';
  const selectedTitleVar = cfg.selected_title_var || 'selected_destination_name';
  const selectedItemVar = cfg.selected_item_var || 'selected_destination';
  const selectedEmployeeVar =
    cfg.selected_assigned_employee_id_var || 'selected_assigned_employee_id';
  if (selected.isNone) {
    if (!cfg.none_next_node_key) return { kind: 'unmatched' };
    const vars = {
      ...run.vars,
      [selectedIdVar]: null,
      [selectedTitleVar]: null,
      [selectedItemVar]: null,
      [selectedEmployeeVar]: null,
      [pageKey]: 0,
      __travel_crm_destination: null,
      __travel_crm_destination_none: true,
    };
    if (!(await persistRunVars(db, run, vars, node.node_key))) {
      return { kind: 'unmatched' };
    }
    await logEvent(db, run.id, 'node_entered', node.node_key, {
      dynamic_selection: true,
      destination_none: true,
    });
    return { kind: 'matched', nextNodeKey: cfg.none_next_node_key };
  }
  const employeeField = cfg.dynamic_assigned_employee_id_field || 'assigned_employee_id';
  const assignedEmployeeId = resolveVariablePath(selected.item, employeeField);
  const trustedDestinations = run.vars.__travel_crm_destinations;
  const trustedDestination = Array.isArray(trustedDestinations)
    ? trustedDestinations.find(
        (item) =>
          isRecord(item) &&
          item.destination_id === selected.id &&
          item.assignment_status === 'assigned' &&
          typeof item.assigned_employee_id === 'string' &&
          UUID_PATTERN.test(item.assigned_employee_id)
      )
    : undefined;
  const selectedTitle = trustedDestination
    ? trustedDestination.destination_name
    : selected.title;
  const selectedItem = trustedDestination ?? selected.item;
  const vars = {
    ...run.vars,
    [selectedIdVar]: selected.id,
    [selectedTitleVar]: selectedTitle,
    [selectedItemVar]: selectedItem,
    [selectedEmployeeVar]:
      trustedDestination?.assigned_employee_id ??
      (typeof assignedEmployeeId === 'string' ? assignedEmployeeId : null),
    [pageKey]: 0,
    ...(trustedDestination ? { __travel_crm_destination: trustedDestination } : {}),
  };
  if (!(await persistRunVars(db, run, vars, node.node_key))) {
    return { kind: 'unmatched' };
  }
  await logEvent(db, run.id, 'node_entered', node.node_key, {
    dynamic_selection: true,
    captured_id_var: selectedIdVar,
    captured_title_var: selectedTitleVar,
    assigned_employee_present: typeof assignedEmployeeId === 'string',
  });
  if (!cfg.dynamic_next_node_key) return { kind: 'unmatched' };
  return { kind: 'matched', nextNodeKey: cfg.dynamic_next_node_key };
}

async function handleDestinationReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  replyId: string
): Promise<
  | { kind: 'matched'; nextNodeKey: string }
  | { kind: 'unmatched' }
  | { kind: 'handed_off' }
> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const scopeValue = run.vars[cfg.destination_scope_var ?? 'destination_scope'];
  if (scopeValue !== 'domestic' && scopeValue !== 'international') {
    await handoffFromDestinationPicker(
      db,
      run,
      node,
      "We couldn't determine which destinations to show. A travel agent will help you.",
      'destination_scope_missing'
    );
    return { kind: 'handed_off' };
  }

  let destinations: TravelDestination[];
  try {
    destinations = await fetchTravelDestinations(scopeValue);
  } catch (err) {
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: 'destination_lookup_failed',
      detail:
        err instanceof Error ? err.message.slice(0, 300) : 'lookup failed',
    });
    await handoffFromDestinationPicker(
      db,
      run,
      node,
      "We're unable to load destinations right now. A travel agent will help you shortly.",
      'destination_lookup_failed'
    );
    return { kind: 'handed_off' };
  }
  if (destinations.length === 0) {
    await handoffFromDestinationPicker(
      db,
      run,
      node,
      'There are no destinations available in this category right now. A travel agent will help you.',
      'destination_choices_empty'
    );
    return { kind: 'handed_off' };
  }

  if (replyId === 'destination:next' || replyId === 'destination:previous') {
    const requestedPage = Number(run.vars.destination_page ?? 0);
    const { pageCount } = buildDestinationPage(destinations, requestedPage);
    const nextPage = Math.min(
      Math.max(requestedPage + (replyId === 'destination:next' ? 1 : -1), 0),
      pageCount - 1
    );
    if (nextPage === requestedPage) return { kind: 'unmatched' };
    const newVars = { ...run.vars, destination_page: String(nextPage) };
    const { error } = await db
      .from('flow_runs')
      .update({ vars: newVars })
      .eq('id', run.id);
    if (error) {
      await handoffFromDestinationPicker(
        db,
        run,
        node,
        "We couldn't load the next destination page. A travel agent will help you.",
        'destination_page_persist_failed'
      );
      return { kind: 'handed_off' };
    }
    run.vars = newVars;
    return { kind: 'matched', nextNodeKey: node.node_key };
  }

  if (!replyId.startsWith('destination:')) return { kind: 'unmatched' };
  const destinationId = replyId.slice('destination:'.length);
  const selected = destinations.find(
    (destination) => destination.id === destinationId
  );
  if (!selected) return { kind: 'unmatched' };

  const newVars = {
    ...run.vars,
    destination: selected.name,
    destination_id: selected.id,
    destination_scope: selected.scope,
    destination_assignment_status: selected.assignment_status,
    destination_readiness: selected.assignment_status,
    destination_selection: {
      id: selected.id,
      name: selected.name,
      scope: selected.scope,
      assignment_status: selected.assignment_status,
    },
  };
  const { error } = await db
    .from('flow_runs')
    .update({ vars: newVars })
    .eq('id', run.id);
  if (error) {
    await handoffFromDestinationPicker(
      db,
      run,
      node,
      "We couldn't save your destination. A travel agent will help you.",
      'destination_selection_persist_failed'
    );
    return { kind: 'handed_off' };
  }
  run.vars = newVars;
  await logEvent(db, run.id, 'node_entered', node.node_key, {
    captured_key: 'destination_id',
    destination_scope: selected.scope,
    assignment_status: selected.assignment_status,
  });

  if (selected.pdf) {
    try {
      const { whatsapp_message_id } = await engineSendMedia({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id!,
        contactId: run.contact_id!,
        kind: 'document',
        link: selected.pdf.url,
        filename: selected.pdf.name.slice(0, 255),
        caption: `${selected.name} travel information`,
      });
      await logEvent(db, run.id, 'message_sent', node.node_key, {
        node_type: 'destination_pdf',
        destination_id: selected.id,
        whatsapp_message_id,
      });
    } catch (err) {
      await logEvent(db, run.id, 'error', node.node_key, {
        reason: 'destination_pdf_send_failed',
        destination_id: selected.id,
        detail:
          err instanceof Error ? err.message.slice(0, 300) : 'PDF send failed',
      });
      await handoffFromDestinationPicker(
        db,
        run,
        node,
        "I couldn't send that destination's information. A travel agent will help you shortly.",
        'destination_pdf_send_failed'
      );
      return { kind: 'handed_off' };
    }
  }

  if (!cfg.selection_next_node_key) {
    await handoffFromDestinationPicker(
      db,
      run,
      node,
      "Your destination was saved, but we couldn't continue the enquiry. A travel agent will help you.",
      'destination_next_node_missing'
    );
    return { kind: 'handed_off' };
  }
  return { kind: 'matched', nextNodeKey: cfg.selection_next_node_key };
}

async function handoffFromDestinationPicker(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  customerMessage: string,
  reason: string
): Promise<void> {
  try {
    await engineSendText({
      accountId: run.account_id,
      userId: run.user_id,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: customerMessage,
    });
  } catch (err) {
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: 'destination_handoff_notice_failed',
      detail:
        err instanceof Error
          ? err.message.slice(0, 300)
          : 'message send failed',
    });
  }
  if (run.conversation_id) {
    await db
      .from('conversations')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', run.conversation_id);
  }
  await logEvent(db, run.id, 'handoff', node.node_key, { reason });
  await endRun(db, run.id, 'handed_off', reason);
}

function isAgentHandoffRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return [
    'agent',
    'speak to agent',
    'speak with agent',
    'talk to agent',
    'talk with agent',
    'please connect me to an agent',
    'connect me to an agent',
  ].includes(normalized);
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const hasTravelCrmContext =
    getVerifiedDestination(run.vars) !== null ||
    run.vars.travel_type === 'domestic' ||
    run.vars.travel_type === 'international' ||
    Array.isArray(run.vars.__travel_crm_destinations);
  if (hasTravelCrmContext) {
    try {
      const payload = await buildTravelCrmEnquiryPayload(
        db,
        run,
        {
          customer_name: 'customer_name',
          travel_date: 'travel_date',
          adults: 'adults',
          children: 'children',
          departure_city: 'departure_city',
          budget: 'budget',
          special_requirements: 'special_requirements',
          whatsapp_number: 'whatsapp_number',
          email: 'email',
        },
        true,
        true
      );
      const enquiry = await completeTravelCrmEnquiry(payload);
      const { error: varsError } = await db
        .from('flow_runs')
        .update({
          vars: { ...run.vars, travel_crm_enquiry: enquiry },
          crm_sync_completed_at: new Date().toISOString(),
          crm_sync_attempts: 0,
          crm_sync_last_error: null,
        })
        .eq('id', run.id);
      if (varsError) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'travel_crm_handoff_result_persist_failed',
          detail: varsError.message,
        });
      } else {
        run.vars = { ...run.vars, travel_crm_enquiry: enquiry };
      }
      await logEvent(db, run.id, 'node_entered', node.node_key, {
        node_type: 'travel_crm_complete_enquiry',
        enquiry_id: enquiry.enquiry_id,
        enquiry_number: enquiry.enquiry_number,
        partial: true,
      });
    } catch (err) {
      await logEvent(db, run.id, 'error', node.node_key, {
        reason: 'travel_crm_handoff_completion_failed',
        detail: err instanceof Error ? err.message.slice(0, 300) : 'completion failed',
      });
    }
  }
  const convUpdate: Record<string, unknown> = {
    status: 'pending',
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from('conversations')
      .update(convUpdate)
      .eq('id', run.conversation_id);
  }
  await logEvent(db, run.id, 'handoff', node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, 'handed_off', 'handoff_node');
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === 'var') {
    const v = run.vars[cfg.subject_key];
    subjectValue =
      typeof v === 'string' ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === 'tag') {
    const { count } = await db
      .from('contact_tags')
      .select('contact_id', { count: 'exact', head: true })
      .eq('contact_id', run.contact_id!)
      .eq('tag_id', cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ['name', 'email', 'phone', 'company'] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from('contacts')
      .select(cfg.subject_key)
      .eq('id', run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
export function interpolateVars(
  template: string,
  vars: Record<string, unknown>
): string {
  if (!template) return '';
  return template.replace(
    /\{\{(?:vars\.)?([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}\}/g,
    (_, path: string) => {
    const v = resolveVariablePath(vars, path);
    return v === undefined || v === null ? '' : String(v);
    }
  );
}

function resolveVariablePath(
  vars: Record<string, unknown>,
  path: string
): unknown {
  let value: unknown = vars;
  for (const key of path.split('.')) {
    if (
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, key)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

async function persistRunVars(
  db: AdminClient,
  run: FlowRunRow,
  vars: Record<string, unknown>,
  nodeKey: string
): Promise<boolean> {
  const { error } = await db.from('flow_runs').update({ vars }).eq('id', run.id);
  if (error) {
    await logEvent(db, run.id, 'error', nodeKey, {
      reason: 'flow_variables_persist_failed',
      detail: error.message,
    });
    return false;
  }
  run.vars = vars;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getVerifiedDestination(
  vars: Record<string, unknown>
): TravelCrmDestination | null {
  const value = vars.__travel_crm_destination;
  if (
    !isRecord(value) ||
    typeof value.destination_id !== 'string' ||
    !UUID_PATTERN.test(value.destination_id) ||
    typeof value.destination_name !== 'string' ||
    !value.destination_name.trim() ||
    (value.travel_type !== 'domestic' && value.travel_type !== 'international') ||
    value.assignment_status !== 'assigned' ||
    typeof value.assigned_employee_id !== 'string' ||
    !UUID_PATTERN.test(value.assigned_employee_id)
  ) {
    return null;
  }
  return value as unknown as TravelCrmDestination;
}

function destinationVariableMatches(
  value: unknown,
  verified: TravelCrmDestination
): boolean {
  if (!isRecord(value)) return false;
  const id = value.destination_id ?? value.id;
  return id === verified.destination_id;
}

function safeFlowAnswers(
  vars: Record<string, unknown>,
  variableMap: Record<string, string>
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (
      key.startsWith('__travel_crm_') ||
      /(password|passcode|otp|token|secret|card|cvv|cvc|bank)/i.test(key)
    ) {
      continue;
    }
    answers[key.slice(0, 100)] =
      typeof value === 'string'
        ? value.slice(0, 600)
        : value === null ||
            typeof value === 'boolean' ||
            typeof value === 'number'
          ? value
          : (JSON.stringify(value) ?? String(value)).slice(0, 600);
    if (Object.keys(answers).length >= 50) break;
  }
  for (const [field, sourceKey] of Object.entries(variableMap)) {
    if (
      !/^[a-zA-Z0-9_]{1,100}$/.test(field) ||
      !sourceKey ||
      (Object.keys(answers).length >= 50 && !Object.prototype.hasOwnProperty.call(answers, field))
    ) {
      continue;
    }
    const value = vars[sourceKey];
    if (value === undefined) continue;
    answers[field] =
      typeof value === 'string'
        ? value.slice(0, 600)
        : value === null ||
            typeof value === 'boolean' ||
            typeof value === 'number'
          ? value
          : (JSON.stringify(value) ?? String(value)).slice(0, 600);
  }
  return answers;
}

async function buildTravelCrmEnquiryPayload(
  db: AdminClient,
  run: FlowRunRow,
  variableMap: Record<string, string>,
  isPartial: boolean,
  handoffRequested: boolean
): Promise<TravelCrmEnquiryPayload> {
  if (!run.contact_id) {
    throw new Error('The flow run has no contact to link to the enquiry.');
  }
  const [{ data: contact, error: contactError }, { data: flow, error: flowError }] =
    await Promise.all([
      db
        .from('contacts')
        .select('id, name, phone, email')
        .eq('id', run.contact_id)
        .maybeSingle(),
      db.from('flows').select('name').eq('id', run.flow_id).maybeSingle(),
    ]);
  if (contactError || !contact) {
    throw new Error(contactError?.message || 'The WACRM contact could not be loaded.');
  }
  if (flowError || !flow) {
    throw new Error(flowError?.message || 'The flow name could not be loaded.');
  }

  const mapped = (key: string): unknown => {
    const variable = variableMap[key];
    return variable ? run.vars[variable] : undefined;
  };
  const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const name = stringValue(mapped('customer_name')) || contact.name?.trim() || null;
  const rawEmail = stringValue(mapped('email')) || contact.email?.trim() || null;
  const email =
    rawEmail &&
    rawEmail.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
      ? rawEmail
      : null;
  const rawPhone =
    contact.phone?.trim() || stringValue(mapped('whatsapp_number')) || null;
  const phone =
    rawPhone && rawPhone.length >= 7 && rawPhone.length <= 32
      ? rawPhone
      : null;
  const verifiedDestination =
    run.vars.__travel_crm_destination_none === true
      ? null
      : getVerifiedDestination(run.vars);
  const answers = safeFlowAnswers(run.vars, variableMap);
  if (run.vars.__travel_crm_destination_none === true) {
    for (const key of [
      'destination_id',
      'destination_name',
      'assigned_employee_id',
      'selected_destination_id',
      'selected_destination_name',
      'selected_destination',
      'selected_assigned_employee_id',
    ]) {
      delete answers[key];
    }
    answers.destination_id = null;
    answers.destination_name = null;
    answers.assigned_employee_id = null;
    for (const key of ['destination_id', 'destination_name', 'assigned_employee_id']) {
      const answerKey = variableMap[key];
      if (answerKey) delete answers[answerKey];
    }
  }
  if (verifiedDestination) {
    answers.travel_type = verifiedDestination.travel_type;
    answers.destination_id = verifiedDestination.destination_id;
    answers.destination_name = verifiedDestination.destination_name;
    answers.assigned_employee_id = verifiedDestination.assigned_employee_id;
  }

  return {
    version: 1,
    flow_run_id: run.id,
    flow_id: run.flow_id,
    wacrm_contact_id: contact.id,
    wacrm_conversation_id: run.conversation_id,
    flow_name: flow.name.slice(0, 200),
    completed_at: new Date().toISOString(),
    is_partial: isPartial,
    handoff_requested: handoffRequested,
    contact: {
      name: name?.slice(0, 200) ?? null,
      email: email?.slice(0, 254) ?? null,
      phone: phone?.slice(0, 32) ?? null,
    },
    destination: verifiedDestination
      ? {
          id: verifiedDestination.destination_id,
          name: verifiedDestination.destination_name,
          scope: verifiedDestination.travel_type,
          assignment_status: 'assigned',
          assigned_employee_id: verifiedDestination.assigned_employee_id,
        }
      : null,
    answers,
  };
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: 'completed' | 'handed_off' | 'timed_out' | 'failed',
  reason: string
): Promise<void> {
  await db
    .from('flow_runs')
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq('id', runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>
): Promise<{ outcome: 'advanced' | 'completed' | 'handed_off' }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, 'error', null, {
        reason: 'next_node_key was null mid-advance',
      });
      await endRun(db, run.id, 'failed', 'missing_next_node');
      return { outcome: 'completed' };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, 'error', currentKey, {
        reason: 'node_not_found',
      });
      await endRun(db, run.id, 'failed', 'node_not_found');
      return { outcome: 'completed' };
    }
    await logEvent(db, run.id, 'node_entered', node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === 'start') {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === 'send_message') {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_message',
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_text_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'send_text_failed');
        return { outcome: 'completed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (
      node.node_type === 'travel_crm_get_destinations' ||
      node.node_type === 'travel_crm_get_destination' ||
      node.node_type === 'travel_crm_complete_enquiry'
    ) {
      const cfg = node.config as unknown as
        | TravelCrmGetDestinationsNodeConfig
        | TravelCrmGetDestinationNodeConfig
        | TravelCrmCompleteEnquiryNodeConfig;
      try {
        if (node.node_type === 'travel_crm_get_destinations') {
          const actionConfig = cfg as TravelCrmGetDestinationsNodeConfig;
          if (
            actionConfig.travel_type !== 'domestic' &&
            actionConfig.travel_type !== 'international'
          ) {
            throw new Error('Travel type must be domestic or international.');
          }
          const destinations = await getTravelCrmDestinations(
            actionConfig.travel_type
          );
          if (destinations.length === 0) {
            throw new Error('Travel CRM returned no assigned active destinations.');
          }
          const nextVars = {
            ...run.vars,
            [actionConfig.result_var]: destinations,
            [actionConfig.error_var]: null,
            __travel_crm_destinations: destinations,
            __travel_crm_destination: null,
          };
          if (!(await persistRunVars(db, run, nextVars, node.node_key))) {
            await endRun(db, run.id, 'failed', 'travel_crm_vars_persist_failed');
            return { outcome: 'completed' };
          }
        } else if (node.node_type === 'travel_crm_get_destination') {
          const actionConfig = cfg as TravelCrmGetDestinationNodeConfig;
          const destinationId = run.vars[actionConfig.destination_id_var];
          const scope = run.vars[actionConfig.travel_type_var];
          if (
            typeof destinationId !== 'string' ||
            (scope !== 'domestic' && scope !== 'international')
          ) {
            throw new Error('A valid destination ID and travel type are required.');
          }
          const destination = await getTravelCrmDestination(scope, destinationId);
          const nextVars = {
            ...run.vars,
            [actionConfig.result_var]: destination,
            [actionConfig.error_var]: null,
            __travel_crm_destination: destination,
          };
          if (!(await persistRunVars(db, run, nextVars, node.node_key))) {
            await endRun(db, run.id, 'failed', 'travel_crm_vars_persist_failed');
            return { outcome: 'completed' };
          }
        } else {
          const actionConfig = cfg as TravelCrmCompleteEnquiryNodeConfig;
          const verifiedDestination = getVerifiedDestination(run.vars);
          if (
            verifiedDestination &&
            actionConfig.destination_var &&
            !destinationVariableMatches(
              run.vars[actionConfig.destination_var],
              verifiedDestination
            )
          ) {
            throw new Error(
              'The configured destination variable does not match the verified CRM destination.'
            );
          }
          const payload = await buildTravelCrmEnquiryPayload(
            db,
            run,
            actionConfig.variable_map ?? {},
            false,
            false
          );
          const enquiry = await completeTravelCrmEnquiry(payload);
          const nextVars = {
            ...run.vars,
            [actionConfig.result_var]: enquiry,
            [actionConfig.error_var]: null,
          };
          if (!(await persistRunVars(db, run, nextVars, node.node_key))) {
            await endRun(db, run.id, 'failed', 'travel_crm_vars_persist_failed');
            return { outcome: 'completed' };
          }
          const { error: acknowledgeError } = await db
            .from('flow_runs')
            .update({
              crm_sync_completed_at: new Date().toISOString(),
              crm_sync_attempts: 0,
              crm_sync_last_error: null,
            })
            .eq('id', run.id);
          if (acknowledgeError) {
            await logEvent(db, run.id, 'error', node.node_key, {
              reason: 'travel_crm_completion_acknowledge_failed',
              detail: acknowledgeError.message,
            });
          }
        }
        await logEvent(db, run.id, 'node_entered', node.node_key, {
          node_type: node.node_type,
          result_saved: true,
        });
        currentKey = cfg.success_next_node_key;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message.slice(0, 300) : 'Travel CRM action failed.';
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'travel_crm_action_failed',
          detail: errorMessage,
        });
        const actionErrorVar = cfg.error_var;
        const actionResultVar = cfg.result_var;
        if (
          !actionErrorVar ||
          !actionResultVar ||
          !(await persistRunVars(
            db,
            run,
            {
              ...run.vars,
              [actionResultVar]: null,
              [actionErrorVar]: errorMessage,
            },
            node.node_key
          ))
        ) {
          await endRun(db, run.id, 'failed', 'travel_crm_action_failed');
          return { outcome: 'completed' };
        }
        if (!cfg.error_next_node_key) {
          await endRun(db, run.id, 'failed', 'travel_crm_action_failed');
          return { outcome: 'completed' };
        }
        currentKey = cfg.error_next_node_key;
      }
      continue;
    }
    if (node.node_type === 'send_media') {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      const mediaUrl = interpolateVars(cfg.media_url, run.vars);
      if (!mediaUrl && /\{\{(?:vars\.)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\}\}/.test(cfg.media_url)) {
        await logEvent(db, run.id, 'node_entered', node.node_key, {
          node_type: 'send_media',
          skipped: true,
          reason: 'media_variable_empty',
        });
        currentKey = cfg.next_node_key;
        continue;
      }
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: mediaUrl,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'send_media',
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_media_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'send_media_failed');
        return { outcome: 'completed' };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'collect_input') {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, 'message_sent', node.node_key, {
          node_type: 'collect_input',
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from('messages')
          .select('id')
          .eq('message_id', whatsapp_message_id)
          .maybeSingle();
        await db
          .from('flow_runs')
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq('id', run.id);
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'collect_input_prompt_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'collect_input_prompt_failed');
        return { outcome: 'completed' };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'condition') {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: 'true' | 'false';
      try {
        branch = (await evaluateConditionNode(db, run, cfg)) ? 'true' : 'false';
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'condition_evaluation_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'condition_evaluation_failed');
        return { outcome: 'completed' };
      }
      currentKey = branch === 'true' ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, 'node_entered', node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === 'set_tag') {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === 'add') {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'set_tag_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === 'send_buttons') {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_buttons_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, 'failed', 'send_buttons_failed');
        return { outcome: 'completed' };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'send_list') {
      try {
        const cfg = node.config as unknown as SendListNodeConfig;
        if (cfg.dynamic_source_var) {
          await sendDynamicListAndSuspend(db, run, node);
        } else if (cfg.dynamic_destinations) {
          const scopeValue =
            run.vars[cfg.destination_scope_var ?? 'destination_scope'];
          if (scopeValue !== 'domestic' && scopeValue !== 'international') {
            await handoffFromDestinationPicker(
              db,
              run,
              node,
              "We couldn't determine which destinations to show. A travel agent will help you.",
              'destination_scope_missing'
            );
            return { outcome: 'handed_off' };
          }
          let destinations: TravelDestination[];
          try {
            destinations = await fetchTravelDestinations(scopeValue);
          } catch (err) {
            await logEvent(db, run.id, 'error', node.node_key, {
              reason: 'destination_lookup_failed',
              detail:
                err instanceof Error
                  ? err.message.slice(0, 300)
                  : 'lookup failed',
            });
            await handoffFromDestinationPicker(
              db,
              run,
              node,
              "We're unable to load destinations right now. A travel agent will help you shortly.",
              'destination_lookup_failed'
            );
            return { outcome: 'handed_off' };
          }
          if (destinations.length === 0) {
            await handoffFromDestinationPicker(
              db,
              run,
              node,
              'There are no destinations available in this category right now. A travel agent will help you.',
              'destination_choices_empty'
            );
            return { outcome: 'handed_off' };
          }
          await sendDestinationListAndSuspend(db, run, node, destinations);
        } else {
          await sendListAndSuspend(db, run, node);
        }
      } catch (err) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'send_list_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        const cfg = node.config as unknown as SendListNodeConfig;
        if (cfg.dynamic_destinations) {
          await handoffFromDestinationPicker(
            db,
            run,
            node,
            "We couldn't show destinations right now. A travel agent will help you shortly.",
            'destination_list_send_failed'
          );
          return { outcome: 'handed_off' };
        }
        await endRun(db, run.id, 'failed', 'send_list_failed');
        return { outcome: 'completed' };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key
      );
      if (!advanced) {
        await logEvent(db, run.id, 'error', node.node_key, {
          reason: 'lost_race_during_advance',
        });
      }
      return { outcome: 'advanced' };
    }
    if (node.node_type === 'handoff') {
      await executeHandoff(db, run, node);
      return { outcome: 'handed_off' };
    }
    if (node.node_type === 'end') {
      await logEvent(db, run.id, 'completed', node.node_key);
      await endRun(db, run.id, 'completed', 'end_node');
      return { outcome: 'completed' };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, 'error', node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, 'failed', 'unknown_node_type');
    return { outcome: 'completed' };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, 'error', currentKey, {
    reason: 'advance_loop_safety_break',
  });
  await endRun(db, run.id, 'failed', 'advance_loop_overflow');
  return { outcome: 'completed' };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from('flow_runs')
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq('id', runId)
    .eq('status', 'active');
  if (expectedOldKey === null) {
    q = q.is('current_node_key', null);
  } else {
    q = q.eq('current_node_key', expectedOldKey);
  }
  const { data, error } = await q.select('id');
  if (error) {
    console.error('[flows] advanceCurrentNodeKey error:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean }
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: 'duplicate_inbound_ignored',
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const selection = await findEntryFlow(
      db,
      input.accountId,
      input.contactId,
      input.message,
      input.isFirstInboundMessage
    );
    if (!selection) {
      return { consumed: false, outcome: 'no_match' };
    }
    if (selection.kind === 'already_handled') {
      return { consumed: true, outcome: 'already_completed' };
    }
    const flow = selection.flow;
    if (!flow.entry_node_id) {
      return { consumed: false, outcome: 'no_match' };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      '[flows] dispatchInboundToFlows threw:',
      err instanceof Error ? err.message : err
    );
    return { consumed: false, outcome: 'no_match' };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, 'reply_received', run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === 'interactive_reply' ? message.reply_id : null,
    text_length: message.kind === 'text' ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, 'failed', 'active_run_missing_current_node');
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: 'no_match',
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, 'failed', 'current_node_not_found');
    return { consumed: true, flow_run_id: run.id, outcome: 'no_match' };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === 'interactive_reply' &&
    (currentNode.node_type === 'send_buttons' ||
      currentNode.node_type === 'send_list')
  ) {
    const listConfig = currentNode.config as unknown as SendListNodeConfig;
    if (currentNode.node_type === 'send_list' && listConfig.dynamic_source_var) {
      try {
        const result = await handleDynamicListReply(
          db,
          run,
          currentNode,
          message.reply_id
        );
        matched = result.kind === 'matched' ? result.nextNodeKey : null;
      } catch (err) {
        await logEvent(db, run.id, 'error', currentNode.node_key, {
          reason: 'dynamic_list_reply_failed',
          detail: err instanceof Error ? err.message.slice(0, 300) : 'reply failed',
        });
        matched = null;
      }
    } else if (
      currentNode.node_type === 'send_list' &&
      listConfig.dynamic_destinations
    ) {
      const result = await handleDestinationReply(
        db,
        run,
        currentNode,
        message.reply_id
      );
      if (result.kind === 'handed_off') {
        return {
          consumed: true,
          flow_run_id: run.id,
          outcome: 'handed_off',
        };
      }
      matched = result.kind === 'matched' ? result.nextNodeKey : null;
    } else {
      matched = matchReplyId(currentNode, message.reply_id);
    }
  } else if (
    message.kind === 'text' &&
    currentNode.node_type === 'collect_input'
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      if (cfg.validation === 'number' && !isValidNumericInput(captured, cfg)) {
        await logEvent(db, run.id, 'fallback_fired', currentNode.node_key, {
          action: 'validation_reprompt',
          validation: 'number',
          text_length: captured.length,
        });
        try {
          await engineSendText({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            text:
              cfg.invalid_input_message ?? 'Please enter a valid whole number.',
          });
        } catch (err) {
          await logEvent(db, run.id, 'error', currentNode.node_key, {
            reason: 'validation_reprompt_send_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        return {
          consumed: true,
          flow_run_id: run.id,
          outcome: 'fallback_fired',
        };
      }
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from('flow_runs')
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq('id', run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, 'node_entered', currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    if (
      message.kind === 'interactive_reply' &&
      currentNode.node_type === 'send_buttons'
    ) {
      const cfg = currentNode.config as unknown as SendButtonsNodeConfig;
      const tapped = cfg.buttons.find(
        (button) => button.reply_id === message.reply_id
      );
      if (tapped?.set_vars && Object.keys(tapped.set_vars).length > 0) {
        const newVars = { ...run.vars, ...tapped.set_vars };
        const { error } = await db
          .from('flow_runs')
          .update({ vars: newVars })
          .eq('id', run.id);
        if (error) {
          await logEvent(db, run.id, 'error', currentNode.node_key, {
            reason: 'button_vars_persist_failed',
          });
          await handoffFromDestinationPicker(
            db,
            run,
            currentNode,
            "We couldn't save your destination preference. A travel agent will help you.",
            'destination_scope_persist_failed'
          );
          return {
            consumed: true,
            flow_run_id: run.id,
            outcome: 'handed_off',
          };
        }
        run.vars = newVars;
      }
    }
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from('flow_runs')
        .update({ reprompt_count: 0 })
        .eq('id', run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from('flow_runs')
    .update({ reprompt_count: newReprompts })
    .eq('id', run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, 'fallback_fired', run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === 'ignore') {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: 'no_match' };
  }
  if (action.type === 'reprompt') {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === 'send_buttons') {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === 'send_list') {
        const listConfig = currentNode.config as unknown as SendListNodeConfig;
        if (listConfig.dynamic_source_var) {
          await sendDynamicListAndSuspend(db, run, currentNode);
        } else if (listConfig.dynamic_destinations) {
          const scope = run.vars[
            listConfig.destination_scope_var ?? 'destination_scope'
          ];
          if (scope === 'domestic' || scope === 'international') {
            const destinations = await fetchTravelDestinations(scope);
            await sendDestinationListAndSuspend(
              db,
              run,
              currentNode,
              destinations
            );
          } else {
            await sendListAndSuspend(db, run, currentNode);
          }
        } else {
          await sendListAndSuspend(db, run, currentNode);
        }
      } else if (currentNode.node_type === 'collect_input') {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(db, run.id, 'error', currentNode.node_key, {
        reason: 'reprompt_send_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: 'fallback_fired' };
  }
  if (action.type === 'handoff') {
    if (run.conversation_id) {
      await db
        .from('conversations')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', run.conversation_id);
    }
    await logEvent(db, run.id, 'handoff', run.current_node_key, {
      reason: 'fallback_exhausted',
    });
    await endRun(db, run.id, 'handed_off', 'fallback_exhausted');
    return { consumed: true, flow_run_id: run.id, outcome: 'handed_off' };
  }
  // action.type === 'end'
  await endRun(db, run.id, 'completed', 'fallback_exhausted_end');
  return { consumed: true, flow_run_id: run.id, outcome: 'completed' };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from('flow_runs')
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: 'active',
      current_node_key: flow.entry_node_id,
    })
    .select('*')
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? '';
    if (msg.includes('23505') || msg.includes('duplicate key')) {
      return { consumed: true, outcome: 'duplicate_inbound_ignored' };
    }
    console.error('[flows] startNewRun insert error:', insErr.message);
    return { consumed: false, outcome: 'no_match' };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, 'started', flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc('increment_flow_execution_count', {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error('[flows] execution_count rpc error:', incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === 'advanced' ? 'started' : outcome.outcome,
  };
}

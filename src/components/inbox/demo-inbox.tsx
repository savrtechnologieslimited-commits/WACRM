'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, CheckCheck, MessageCircle, Send, Sparkles } from 'lucide-react';
import { DEMO_WHATSAPP_NUMBERS } from '@/lib/whatsapp/demo-data';
import { cn } from '@/lib/utils';

type DemoMessage = {
  id: string;
  from: 'customer' | 'agent';
  text: string;
  time: string;
};

type DemoConversation = {
  id: string;
  numberId: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  messages: DemoMessage[];
};

const INITIAL_CONVERSATIONS: DemoConversation[] = [
  {
    id: 'demo-conversation-1',
    numberId: DEMO_WHATSAPP_NUMBERS[0].id,
    name: 'Maya Thompson',
    initials: 'MT',
    preview: 'Could you tell me more about the offer?',
    time: '10:42',
    messages: [
      { id: 'm1', from: 'customer', text: 'Hi! I saw your welcome offer.', time: '10:38' },
      { id: 'm2', from: 'agent', text: 'Hi Maya! Happy to help. What would you like to know?', time: '10:40' },
      { id: 'm3', from: 'customer', text: 'Could you tell me more about the offer?', time: '10:42' },
    ],
  },
  {
    id: 'demo-conversation-2',
    numberId: DEMO_WHATSAPP_NUMBERS[1].id,
    name: 'Oliver Chen',
    initials: 'OC',
    preview: 'Thanks, that works for me.',
    time: '09:16',
    messages: [
      { id: 'm4', from: 'customer', text: 'Do you deliver to London?', time: '09:11' },
      { id: 'm5', from: 'agent', text: 'Yes, we deliver across the UK.', time: '09:13' },
      { id: 'm6', from: 'customer', text: 'Thanks, that works for me.', time: '09:16' },
    ],
  },
  {
    id: 'demo-conversation-3',
    numberId: DEMO_WHATSAPP_NUMBERS[0].id,
    name: 'Ava Patel',
    initials: 'AP',
    preview: 'I would like to book a consultation.',
    time: 'Yesterday',
    messages: [
      { id: 'm7', from: 'customer', text: 'I would like to book a consultation.', time: '16:25' },
      { id: 'm8', from: 'agent', text: 'Of course! I can help you arrange that.', time: '16:27' },
    ],
  },
];

export function DemoInbox() {
  const [selectedNumberId, setSelectedNumberId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState(
    INITIAL_CONVERSATIONS[0].id,
  );
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [conversations, setConversations] = useState(INITIAL_CONVERSATIONS);
  const [draft, setDraft] = useState('');

  const visibleConversations = useMemo(
    () =>
      selectedNumberId
        ? conversations.filter((conversation) => conversation.numberId === selectedNumberId)
        : conversations,
    [conversations, selectedNumberId],
  );
  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedConversationId) ??
    visibleConversations[0] ??
    null;

  function sendDemoMessage() {
    const text = draft.trim();
    if (!text || !selectedConversation) return;
    const time = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    setConversations((previous) =>
      previous.map((conversation) =>
        conversation.id === selectedConversation.id
          ? {
              ...conversation,
              preview: text,
              time,
              messages: [
                ...conversation.messages,
                { id: `demo-${Date.now()}`, from: 'agent', text, time },
              ],
            }
          : conversation,
      ),
    );
    setDraft('');
  }

  return (
    <section className="flex h-[calc(100vh-3.5rem)] min-h-[520px] flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300">
        <Sparkles className="size-4" />
        Demo inbox — messages and numbers here are examples. Sending is simulated only.
      </div>
      <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setSelectedNumberId(null)}
          className={cn(
            'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium',
            selectedNumberId === null
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          All demo inboxes
        </button>
        {DEMO_WHATSAPP_NUMBERS.map((number) => (
          <button
            type="button"
            key={number.id}
            onClick={() => {
              setSelectedNumberId(number.id);
              const first = conversations.find((item) => item.numberId === number.id);
              if (first) setSelectedConversationId(first.id);
              setMobileThreadOpen(false);
            }}
            className={cn(
              'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium',
              selectedNumberId === number.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {number.label}
            {number.isPrimary ? ' · Primary' : ''}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'w-full shrink-0 flex-col border-r border-border sm:flex sm:w-72',
            mobileThreadOpen ? 'hidden' : 'flex',
          )}
        >
          <div className="border-b border-border px-4 py-3">
            <p className="font-semibold text-foreground">Conversations</p>
            <p className="text-xs text-muted-foreground">Sample customers by WhatsApp number</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleConversations.map((conversation) => {
              const sender = DEMO_WHATSAPP_NUMBERS.find(
                (number) => number.id === conversation.numberId,
              );
              return (
                <button
                  type="button"
                  key={conversation.id}
                  onClick={() => {
                    setSelectedConversationId(conversation.id);
                    setMobileThreadOpen(true);
                  }}
                  className={cn(
                    'flex w-full items-start gap-3 border-b border-border/70 px-4 py-3 text-left hover:bg-muted/60',
                    selectedConversation?.id === conversation.id && 'bg-muted',
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                    {conversation.initials}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{conversation.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{conversation.time}</span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{conversation.preview}</span>
                    <span className="mt-1 block truncate text-[10px] text-emerald-400">{sender?.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {selectedConversation ? (
          <div
            className={cn(
              'min-w-0 flex-1 flex-col',
              mobileThreadOpen ? 'flex' : 'hidden sm:flex',
            )}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Back to demo conversations"
                  onClick={() => setMobileThreadOpen(false)}
                  className="rounded-full p-1 text-muted-foreground hover:bg-muted sm:hidden"
                >
                  <ArrowLeft className="size-4" />
                </button>
                <span className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {selectedConversation.initials}
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{selectedConversation.name}</p>
                  <p className="text-xs text-muted-foreground">
                    via {DEMO_WHATSAPP_NUMBERS.find((number) => number.id === selectedConversation.numberId)?.label}
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">DEMO</span>
            </header>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto bg-[url('/inbox-doodle.svg')] p-4">
              {selectedConversation.messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm',
                    message.from === 'agent'
                      ? 'ml-auto bg-message-outgoing text-message-outgoing-foreground'
                      : 'mr-auto bg-card text-foreground',
                  )}
                >
                  <p>{message.text}</p>
                  <span className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
                    {message.time}
                    {message.from === 'agent' && <CheckCheck className="size-3" />}
                  </span>
                </div>
              ))}
            </div>
            <form
              className="flex shrink-0 items-center gap-2 border-t border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                sendDemoMessage();
              }}
            >
              <input
                aria-label="Demo message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="h-10 min-w-0 flex-1 rounded-full border border-border bg-muted px-4 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="submit"
                aria-label="Send demo message"
                disabled={!draft.trim()}
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
              >
                <Send className="size-4" />
              </button>
            </form>
          </div>
        ) : (
          <div className="hidden flex-1 items-center justify-center text-muted-foreground sm:flex">
            <div className="text-center">
              <MessageCircle className="mx-auto mb-2 size-9 opacity-50" />
              <p className="text-sm">Choose a sample conversation</p>
            </div>
          </div>
        )}
      </div>
      <p className="shrink-0 border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground sm:hidden">
        Open this page on a wider screen to preview the sample chat and try simulated replies.
      </p>
    </section>
  );
}

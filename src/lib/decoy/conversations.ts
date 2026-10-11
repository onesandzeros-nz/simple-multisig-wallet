import { CONTACTS, DecoyContact, contactById } from './data';

/**
 * The decoy inbox's state and the pure rules that move it: seeding from the
 * scripts in data.ts, replies to what the user sends, and the odd
 * unprompted message so the inbox keeps looking alive. Storage is in
 * decoyStore.ts.
 */

export interface DecoyMessage {
  id: string;
  from: 'me' | 'them';
  text: string;
  at: number;
}

export interface Thread {
  contactId: string;
  messages: DecoyMessage[];
  /** Index into the contact's reply list. */
  replyIndex: number;
  /** Index into the contact's idle list. */
  idleIndex: number;
  unread: boolean;
}

export interface DecoyState {
  version: 1;
  /** When the inbox was seeded. */
  epoch: number;
  threads: Thread[];
  /** Rotates through the contacts for unprompted messages. */
  idleContact: number;
}

/** No new message for this long and someone gets in touch on the next open. */
export const IDLE_GAP_MS = 16 * 60 * 60 * 1000;
const MAX_IDLE_PER_OPEN = 3;

let counter = 0;
function msgId(at: number): string {
  counter += 1;
  return `${at.toString(36)}-${counter.toString(36)}`;
}

export function seedState(now: number): DecoyState {
  return {
    version: 1,
    epoch: now,
    threads: CONTACTS.map((c) => ({
      contactId: c.id,
      messages: c.seed
        .map((m) => ({ id: msgId(now - m.ago * 60_000), from: m.from, text: m.text, at: now - m.ago * 60_000 }))
        .sort((a, b) => a.at - b.at),
      replyIndex: 0,
      idleIndex: 0,
      unread: false,
    })),
    idleContact: 0,
  };
}

export function threadFor(state: DecoyState, contactId: string): Thread {
  return (
    state.threads.find((t) => t.contactId === contactId) ?? {
      contactId,
      messages: [],
      replyIndex: 0,
      idleIndex: 0,
      unread: false,
    }
  );
}

function putThread(state: DecoyState, thread: Thread): DecoyState {
  const others = state.threads.filter((t) => t.contactId !== thread.contactId);
  return { ...state, threads: [...others, thread] };
}

export function lastMessage(thread: Thread): DecoyMessage | undefined {
  return thread.messages[thread.messages.length - 1];
}

/** Threads with messages, most recent first — the inbox order. */
export function inbox(state: DecoyState): Thread[] {
  return state.threads
    .filter((t) => t.messages.length > 0)
    .sort((a, b) => (lastMessage(b)?.at ?? 0) - (lastMessage(a)?.at ?? 0));
}

export function appendMessage(state: DecoyState, contactId: string, from: 'me' | 'them', text: string, at: number): DecoyState {
  const thread = threadFor(state, contactId);
  return putThread(state, {
    ...thread,
    messages: [...thread.messages, { id: msgId(at), from, text, at }],
    unread: from === 'them' ? thread.unread : false,
  });
}

export function markRead(state: DecoyState, contactId: string): DecoyState {
  const thread = threadFor(state, contactId);
  if (!thread.unread) return state;
  return putThread(state, { ...thread, unread: false });
}

/**
 * The contact's answer to the latest message, or null when they do not
 * reply (an outbound-only notification number).
 */
export function replyFor(state: DecoyState, contactId: string): { text: string; state: DecoyState } | null {
  const contact = contactById(contactId);
  if (!contact || contact.replies.length === 0) return null;
  const thread = threadFor(state, contactId);
  const text = contact.replies[thread.replyIndex % contact.replies.length];
  return { text, state: putThread(state, { ...thread, replyIndex: thread.replyIndex + 1 }) };
}

/**
 * Called when the inbox opens. If nothing has happened for a while, one or
 * more contacts have "sent" something in the meantime, spaced out over the
 * gap so they do not all land at once.
 */
export function refreshIdle(state: DecoyState, now: number): DecoyState {
  const latest = Math.max(state.epoch, ...state.threads.flatMap((t) => t.messages.map((m) => m.at)));
  const gap = now - latest;
  if (gap < IDLE_GAP_MS) return state;
  const count = Math.min(MAX_IDLE_PER_OPEN, Math.floor(gap / IDLE_GAP_MS));
  const candidates = CONTACTS.filter((c) => c.idle.length > 0);
  let next = state;
  for (let i = 0; i < count; i++) {
    const contact: DecoyContact = candidates[next.idleContact % candidates.length];
    const thread = threadFor(next, contact.id);
    const text = contact.idle[thread.idleIndex % contact.idle.length];
    // Spread the arrivals back through the gap, the last one recently.
    const at = now - Math.floor((gap * (count - i - 1)) / (count + 1)) - (i + 1) * 7 * 60_000;
    next = putThread(next, {
      ...thread,
      messages: [...thread.messages, { id: msgId(at), from: 'them' as const, text, at }].sort((a, b) => a.at - b.at),
      idleIndex: thread.idleIndex + 1,
      unread: true,
    });
    next = { ...next, idleContact: next.idleContact + 1 };
  }
  return next;
}

// --- Display helpers --------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function timeOfDay(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${suffix}`;
}

/** Inbox timestamp: time today, "Yesterday", a weekday, or a date. */
export function inboxTime(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (sameDay(d, n)) return timeOfDay(at);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (sameDay(d, yesterday)) return 'Yesterday';
  if (now - at < 6 * 24 * 60 * 60 * 1000) return DAY_NAMES[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Date separator inside a chat. */
export function chatDay(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (sameDay(d, n)) return 'Today';
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function isSameDay(a: number, b: number): boolean {
  return sameDay(new Date(a), new Date(b));
}

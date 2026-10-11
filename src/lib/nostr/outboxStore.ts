import AsyncStorage from '@react-native-async-storage/async-storage';
import { GroupOutbox, MAX_RESUMED_CHARS, OutboxItem, OutboxStorage } from './outbox';

const PREFIX = 'outbox.';
const key = (groupId: string) => `${PREFIX}${groupId}`;

/** Whether an AsyncStorage key belongs to a group's outbox. */
export function isOutboxKey(storageKey: string): boolean {
  return storageKey.startsWith(PREFIX);
}

/** The slice of AsyncStorage the outboxes use — injectable so the tests run without a device. */
export type OutboxStore = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem' | 'getAllKeys' | 'multiRemove'>;

/**
 * A group's outbox on disk: messages not yet confirmed by a relay, so a
 * share that failed while the phone was offline goes out on the next launch.
 * Nothing here is more sensitive than what the app already keeps in the
 * same store — rekey envelopes are never written — but it is plaintext, so a
 * wipe has to reach it (`deleteAllOutboxes`). And it is not believed as it
 * is read: the outbox checks every item (`resumable`); this only keeps a
 * store too big to be honest from being parsed at all.
 */
export function outboxStorage(groupId: string, store: OutboxStore = AsyncStorage): OutboxStorage {
  return {
    async load() {
      const raw = await store.getItem(key(groupId));
      if (!raw) return [];
      try {
        if (raw.length > MAX_RESUMED_CHARS) throw new Error('too big to be honest');
        return JSON.parse(raw);
      } catch {
        // Unreadable, so unusable: gone before anything else is written over it.
        await store.removeItem(key(groupId)).catch(() => {});
        return [];
      }
    },
    async save(items) {
      if (items.length === 0) await store.removeItem(key(groupId));
      else await store.setItem(key(groupId), JSON.stringify(items));
    },
  };
}

/** Empties a group's live outbox, if it has one, and removes its copy on disk. */
export async function deleteOutbox(groupId: string, store: OutboxStore = AsyncStorage): Promise<void> {
  forgetOutbox(groupId);
  await store.removeItem(key(groupId));
}

/**
 * Every outbox, live or on disk, whether or not its group is still known. A
 * wipe must not leave a plaintext transaction behind because its group
 * record went first, or because a live outbox wrote itself back afterwards.
 */
export async function deleteAllOutboxes(store: OutboxStore = AsyncStorage): Promise<void> {
  forgetAllOutboxes();
  const keys = (await store.getAllKeys()).filter(isOutboxKey);
  if (keys.length > 0) await store.multiRemove(keys);
}

export interface OutboxEntry {
  outbox: GroupOutbox;
  listeners: Set<(items: OutboxItem[]) => void>;
}

/**
 * One outbox per group, shared by every live session for it (the list's
 * syncer, the screen, its chat), so a message is retried once, not once per
 * session. Screens subscribe to see what is still waiting.
 */
const outboxes = new Map<string, OutboxEntry>();

export function outboxFor(groupId: string, store: OutboxStore = AsyncStorage): OutboxEntry {
  let entry = outboxes.get(groupId);
  if (!entry) {
    const listeners = new Set<(items: OutboxItem[]) => void>();
    const outbox = new GroupOutbox({
      storage: outboxStorage(groupId, store),
      onChange: (items) => listeners.forEach((l) => l(items)),
    });
    entry = { outbox, listeners };
    outboxes.set(groupId, entry);
  }
  return entry;
}

/** Empties a group's live outbox and drops it from the registry. */
export function forgetOutbox(groupId: string): void {
  const entry = outboxes.get(groupId);
  if (!entry) return;
  entry.outbox.clear();
  outboxes.delete(groupId);
}

export function forgetAllOutboxes(): void {
  for (const groupId of [...outboxes.keys()]) forgetOutbox(groupId);
}

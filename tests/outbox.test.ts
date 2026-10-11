import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelId, decryptPayload, generateSecretKey, getPublicKey, NostrEvent, signEvent } from '../src/lib/nostr/crypto';
import { GroupMessage, GROUP_EVENT_KIND, MAX_CHAT_CHARS, Refusal, REKEY_EVENT_KIND } from '../src/lib/nostr/protocol';
import { GroupSession } from '../src/lib/nostr/session';
import {
  GroupOutbox,
  MAX_RESUMED_CHARS,
  MAX_RESUMED_ITEMS,
  OutboxItem,
  OutboxPublisher,
  OutboxStorage,
  resumable,
} from '../src/lib/nostr/outbox';
import {
  deleteAllOutboxes,
  deleteOutbox,
  forgetOutbox,
  isOutboxKey,
  outboxFor,
  outboxStorage,
  OutboxStore,
} from '../src/lib/nostr/outboxStore';
import { makeFakeRelay } from './fakeRelay';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quick = () => 5;

function memoryStorage(): OutboxStorage & { items: OutboxItem[]; saves: OutboxItem[][] } {
  const box = {
    items: [] as OutboxItem[],
    saves: [] as OutboxItem[][],
    async load() {
      return box.items;
    },
    async save(items: OutboxItem[]) {
      box.items = items;
      box.saves.push(items);
    },
  };
  return box;
}

function session(
  relay: ReturnType<typeof makeFakeRelay>,
  extra: Partial<ConstructorParameters<typeof GroupSession>[0]> & { secret?: string } = {}
) {
  const secret = extra.secret ?? generateSecretKey();
  const s = new GroupSession({
    epochs: [{ epoch: 0, secret }],
    relays: ['wss://fake'],
    identitySecret: generateSecretKey(),
    socketFactory: relay.factory,
    outbox: new GroupOutbox({ retryDelay: quick, maxAttempts: 3 }),
    reconnectDelay: quick,
    ...extra,
  });
  s.start({ onMessage: () => {} });
  return { session: s, secret };
}

describe('outbox: relay acknowledgements', () => {
  it('lets a message go once a relay confirms it', async () => {
    const relay = makeFakeRelay();
    const { session: s } = session(relay);
    await wait(10);
    s.send({ type: 'chat', name: 'Rob', text: 'hi' });
    assert.equal(s.pending.length, 1, 'waiting for the relay');
    await wait(10);
    assert.equal(s.pending.length, 0, 'the OK cleared it');
    assert.equal(relay.events().length, 1, 'no retry was needed');
    s.stop();
  });

  it('retries while no relay has confirmed, then rests after its budget', async () => {
    const relay = makeFakeRelay({ ack: false });
    const { session: s } = session(relay);
    await wait(10);
    const id = s.send({ type: 'chat', name: 'Rob', text: 'anyone?' });
    await wait(60);
    const copies = relay.events().filter((e) => e.id === id);
    assert.equal(copies.length, 3, 'published up to the budget, as the same event');
    assert.equal(s.pending.length, 1);
    assert.equal(s.pending[0].attempts, 3);
    assert.equal(s.pending[0].rejected, undefined);
    s.stop();
  });

  it('records why a relay refused, and keeps the message', async () => {
    const relay = makeFakeRelay({ reject: () => 'blocked: event too large' });
    const { session: s } = session(relay);
    await wait(10);
    s.send({ type: 'chat', name: 'Rob', text: 'big' });
    await wait(10);
    assert.equal(s.pending.length, 1);
    assert.equal(s.pending[0].rejected, 'blocked: event too large');
    s.stop();
  });

  it('treats a duplicate refusal as stored', async () => {
    const relay = makeFakeRelay({ reject: () => 'duplicate: already have this event' });
    const { session: s } = session(relay);
    await wait(10);
    s.send({ type: 'chat', name: 'Rob', text: 'again' });
    await wait(10);
    assert.equal(s.pending.length, 0);
    s.stop();
  });

  it('starts over on everything waiting when kicked', async () => {
    const relay = makeFakeRelay({ ack: false });
    const outbox = new GroupOutbox({ retryDelay: quick, maxAttempts: 1 });
    const { session: s } = session(relay, { outbox });
    await wait(10);
    const id = s.send({ type: 'chat', name: 'Rob', text: 'once' });
    await wait(20);
    assert.equal(relay.events().filter((e) => e.id === id).length, 1, 'budget of one');
    outbox.kick();
    await wait(20);
    assert.equal(relay.events().filter((e) => e.id === id).length, 2, 'tried again');
    s.stop();
  });
});

describe('outbox: reconnecting', () => {
  it('reopens a dropped socket, subscribes again and resends what was not stored', async () => {
    const relay = makeFakeRelay({ ack: false });
    const { session: s } = session(relay);
    await wait(10);
    const id = s.send({ type: 'chat', name: 'Rob', text: 'before the drop' });
    relay.sockets[0].close();
    await wait(40);
    assert.equal(relay.sockets.length, 2, 'a new socket was opened');
    assert.equal(relay.log.filter((m) => m[0] === 'REQ').length, 2, 'subscribed again on the new socket');
    assert.ok(relay.events().filter((e) => e.id === id).length >= 2, 'the message went out again');
    s.stop();
    await wait(20);
    assert.equal(relay.sockets.length, 2, 'no reconnect after stop');
  });

  it('queues a publish for a relay that is down and sends it when it is back', async () => {
    const relay = makeFakeRelay();
    const { session: s } = session(relay);
    await wait(10);
    relay.sockets[0].close();
    // Closed, not yet reopened: the publish has nowhere to go.
    const id = s.send({ type: 'chat', name: 'Rob', text: 'while down' });
    assert.equal(relay.events().filter((e) => e.id === id).length, 0);
    await wait(30);
    assert.ok(relay.events().some((e) => e.id === id), 'sent once the relay was back');
    assert.equal(s.pending.length, 0, 'and confirmed');
    s.stop();
  });
});

describe('outbox: key rotation', () => {
  it('re-encrypts a waiting message under the new epoch with its original time, and pins the notice to the old channel', async () => {
    const relay = makeFakeRelay({ ack: false });
    const identity = generateSecretKey();
    const { session: c, secret: s0 } = session(relay, {
      identitySecret: identity,
      coordinatorPubkey: getPublicKey(identity),
      rotation: true,
      outbox: new GroupOutbox({ retryDelay: quick, maxAttempts: 2 }),
    });
    await wait(10);
    const chatId = c.send({ type: 'chat', name: 'Rob', text: 'sent on epoch 0' });
    const first = relay.events().find((e) => e.id === chatId)!;
    const { secret: s1, epoch } = c.rotate([c.pubkey]);
    assert.equal(epoch, 1);
    await wait(40);

    const chats = relay
      .events()
      .filter((e) => e.kind === GROUP_EVENT_KIND)
      .map((e) => {
        for (const secret of [s1, s0]) {
          try {
            return { event: e, secret, message: JSON.parse(decryptPayload(secret, e.content)) };
          } catch {
            // not this epoch
          }
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x && x.message.type === 'chat');
    const retried = chats.filter((x) => x.event.id !== chatId);
    assert.ok(retried.length >= 1, 'the chat was sent again after the rotation');
    for (const r of retried) {
      assert.equal(r.secret, s1, 'encrypted under the new epoch, never the old one');
      assert.deepEqual(r.event.tags, [['t', channelId(s1)]]);
      assert.equal(r.event.created_at, first.created_at, 'the original timestamp is kept');
    }
    assert.ok(!retried.some((r) => r.secret === s0));

    const notices = relay
      .events()
      .filter((e) => e.kind === GROUP_EVENT_KIND && e.tags[0][1] === channelId(s0))
      .filter((e) => {
        try {
          return JSON.parse(decryptPayload(s0, e.content)).type === 'rekey-notice';
        } catch {
          return false;
        }
      });
    assert.ok(notices.length >= 2, 'the notice was retried');
    assert.equal(new Set(notices.map((n) => n.id)).size, 1, 'as the identical event, on the old channel');
    c.stop();
  });

  it('retries sealed envelopes unchanged and never writes them to storage', async () => {
    const relay = makeFakeRelay({ ack: false });
    const storage = memoryStorage();
    const identity = generateSecretKey();
    const { session: c } = session(relay, {
      identitySecret: identity,
      coordinatorPubkey: getPublicKey(identity),
      rotation: true,
      outbox: new GroupOutbox({ storage, retryDelay: quick, maxAttempts: 2 }),
    });
    await wait(10);
    c.rotate([c.pubkey, getPublicKey(generateSecretKey())]);
    await wait(40);
    const envelopes = relay.events().filter((e) => e.kind === REKEY_EVENT_KIND);
    assert.equal(new Set(envelopes.map((e) => e.id)).size, 2, 'one envelope per member');
    assert.equal(envelopes.length, 4, 'each sent twice');
    for (const save of storage.saves) assert.ok(save.every((i) => i.kind === 'message'));
    c.stop();
  });

  it('a retry that would break a rule is dropped, not sent', async () => {
    // A message allowed at epoch 0 only because the group never rotates:
    // if the session were somehow switched to a rotating one at epoch 0,
    // the retry must refuse rather than put a key under the invite.
    const relay = makeFakeRelay({ ack: false });
    const outbox = new GroupOutbox({ retryDelay: quick, maxAttempts: 3 });
    const legacy = session(relay, { outbox, rotation: false });
    await wait(10);
    legacy.session.send({ type: 'key', name: 'Rob', keyExpression: '[73c5da0a/48h/0h/0h/2h]xpub' });
    legacy.session.stop();
    const strict = session(relay, { outbox, rotation: true, coordinatorPubkey: getPublicKey(generateSecretKey()), secret: legacy.secret });
    await wait(40);
    assert.equal(strict.session.pending.length, 0, 'dropped by the guard on retry');
    assert.equal(relay.events().length, 1, 'only the original publish');
    strict.session.stop();
  });
});

describe('outbox: ordering and persistence', () => {
  it('keeps only the newest of a latest-wins type', async () => {
    const relay = makeFakeRelay({ ack: false });
    const { session: s } = session(relay);
    await wait(10);
    s.send({ type: 'selection', xpubs: ['a'] });
    s.send({ type: 'selection', xpubs: ['b'] });
    s.send({ type: 'chat', name: 'Rob', text: 'one' });
    s.send({ type: 'chat', name: 'Rob', text: 'two' });
    const types = s.pending.map((i) => i.message?.type);
    assert.deepEqual(types, ['selection', 'chat', 'chat'], 'one selection, both chats');
    assert.deepEqual(s.pending[0].message, { type: 'selection', xpubs: ['b'] });
    s.stop();
  });

  it('persists what no relay confirmed and resumes it in the next session as the same event', async () => {
    const silent = makeFakeRelay({ ack: false });
    const storage = memoryStorage();
    const identity = generateSecretKey();
    const secret = generateSecretKey();
    const first = session(silent, {
      identitySecret: identity,
      secret,
      outbox: new GroupOutbox({ storage, retryDelay: quick, maxAttempts: 1 }),
    });
    await wait(10);
    const id = first.session.send({ type: 'psbt', base64: 'cHNidP8=', memo: 'rent' });
    await wait(10);
    first.session.stop();
    assert.equal(storage.items.length, 1, 'kept on disk');
    assert.equal(storage.items[0].message?.type, 'psbt');

    const working = makeFakeRelay();
    const outbox = new GroupOutbox({ storage, retryDelay: quick, maxAttempts: 3 });
    await outbox.ready;
    const second = session(working, { identitySecret: identity, secret, outbox });
    await wait(30);
    const sent = working.events();
    assert.equal(sent.length, 1, 'went out on the next launch');
    assert.equal(sent[0].id, id, 'the identical event: same epoch, same id');
    assert.equal(storage.items.length, 0, 'and left the disk once confirmed');
    second.session.stop();
  });
});

/** AsyncStorage, as far as the outboxes use it, in a Map. */
function fakeAsyncStorage(initial: Record<string, string> = {}): OutboxStore & { map: Map<string, string>; removed: string[][] } {
  const map = new Map(Object.entries(initial));
  const removed: string[][] = [];
  return {
    map,
    removed,
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
      removed.push([k]);
    },
    async getAllKeys() {
      return [...map.keys()];
    },
    async multiRemove(keys) {
      for (const k of keys) map.delete(k);
      removed.push([...keys]);
    },
  };
}

describe('outbox: wiping', () => {
  it('clears everything it holds, on disk too', async () => {
    const relay = makeFakeRelay({ ack: false });
    const storage = memoryStorage();
    const outbox = new GroupOutbox({ storage, retryDelay: quick, maxAttempts: 3 });
    const { session: s } = session(relay, { outbox });
    await wait(10);
    s.send({ type: 'psbt', base64: 'cHNidP8=', memo: 'rent' });
    s.send({ type: 'chat', name: 'Rob', text: 'secret plans' });
    await wait(10);
    assert.equal(storage.items.length, 2, 'plaintext waiting on disk');

    outbox.clear();
    assert.deepEqual(s.pending, []);
    assert.deepEqual(storage.items, [], 'and gone from disk');
    await wait(30);
    assert.deepEqual(s.pending, [], 'nothing came back on a retry tick');
    s.stop();
  });

  it('deletes every outbox on disk, live ones first, and nothing else', async () => {
    const store = fakeAsyncStorage({
      'outbox.orphan': '[]',
      'sms.keys.v1': '[]',
      'sms.groups.v1': '[]',
    });
    assert.equal(isOutboxKey('outbox.g1'), true);
    assert.equal(isOutboxKey('sms.keys.v1'), false);

    // A live outbox for a group, with something unsent in it.
    const relay = makeFakeRelay({ ack: false });
    const entry = outboxFor('g1', store);
    const { session: s } = session(relay, { outbox: entry.outbox });
    await wait(10);
    s.send({ type: 'psbt', base64: 'cHNidP8=', memo: 'rent' });
    await wait(10);
    assert.ok(store.map.has('outbox.g1'), 'the live outbox wrote itself to disk');
    assert.equal(outboxFor('g1', store), entry, 'one outbox per group');

    await deleteAllOutboxes(store);
    assert.deepEqual([...store.map.keys()].sort(), ['sms.groups.v1', 'sms.keys.v1']);
    assert.deepEqual(entry.outbox.pending, [], 'the live outbox was emptied, not just its file');
    assert.notEqual(outboxFor('g1', store), entry, 'and forgotten');
    await wait(30);
    assert.equal(store.map.has('outbox.g1'), false, 'it did not write itself back');
    s.stop();
    forgetOutbox('g1'); // the registry is module-wide
  });

  it('forgets one group on its own', async () => {
    const store = fakeAsyncStorage({ 'outbox.g4': '[]' });
    const relay = makeFakeRelay({ ack: false });
    const entry = outboxFor('g3', store);
    const { session: s } = session(relay, { outbox: entry.outbox });
    await wait(10);
    s.send({ type: 'chat', name: 'Rob', text: 'hello' });
    await wait(10);
    assert.ok(store.map.has('outbox.g3'));

    await deleteOutbox('g3', store);
    assert.deepEqual(entry.outbox.pending, []);
    assert.equal(store.map.has('outbox.g3'), false);
    assert.equal(store.map.has('outbox.g4'), true, 'another group is left alone');
    assert.notEqual(outboxFor('g3', store), entry, 'forgotten in memory as well');
    forgetOutbox('g3');
    forgetOutbox('never-opened'); // harmless
    s.stop();
  });
});

describe('outbox: resuming from disk', () => {
  // App storage can come back altered (a restored backup); what is resumed
  // is published as this user, so it is believed only as far as it checks.
  const identity = generateSecretKey();
  const signed = (createdAt: number): NostrEvent =>
    signEvent(identity, { created_at: createdAt, kind: GROUP_EVENT_KIND, tags: [['t', 'a'.repeat(64)]], content: 'sealed' });
  const stored = (message: GroupMessage, createdAt = 1000, extra: Record<string, unknown> = {}) => {
    const event = signed(createdAt);
    return { id: event.id, kind: 'message', message, createdAt, epoch: 0, lobby: false, pinned: false, attempts: 5, storedOn: [], event, ...extra };
  };
  const chat = (text = 'hi'): GroupMessage => ({ type: 'chat', name: 'Rob', text });

  it('believes a stored item only as far as it can be checked', () => {
    const item = stored(chat());
    const resumed = resumable([item]);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].attempts, 0, 'a fresh budget');
    assert.deepEqual(resumed[0].event, item.event, 'the signed copy, since it verifies');
    assert.deepEqual(resumed[0].message, chat());

    const tampered = stored(chat());
    tampered.event = { ...tampered.event, content: 'altered' };
    assert.equal(resumable([tampered])[0].event, undefined, 'a copy that does not verify is signed again, through the guards');
    const swapped = stored(chat(), 1000, { id: 'f'.repeat(64) });
    assert.equal(resumable([swapped])[0].event, undefined, 'so is one that is not the event the item names');

    const bad = [
      stored({ type: 'nonsense' } as any),
      stored(chat('x'.repeat(MAX_CHAT_CHARS + 1))),
      stored({ type: 'psbt', base64: 'cHNidP8=' }, 1000, { lobby: true }),
      stored(chat(), 1000, { id: 'not-hex' }),
      stored(chat(), 1000, { epoch: -1 }),
      stored(chat(), 1000, { createdAt: 'soon' }),
      stored(chat(), 1000, { kind: 'envelope' }),
      { kind: 'message' },
      'junk',
      null,
    ];
    assert.deepEqual(resumable(bad), [], 'nothing malformed is resumed');
    assert.deepEqual(resumable('not a list'), []);
  });

  it('resumes at most the newest MAX_RESUMED_ITEMS, and reads nothing from a store too big to be honest', async () => {
    const many = Array.from({ length: MAX_RESUMED_ITEMS + 50 }, (_, i) => stored(chat(`m${i}`), 1000 + i));
    const resumed = resumable(many);
    assert.equal(resumed.length, MAX_RESUMED_ITEMS);
    assert.equal(resumed[0].createdAt, 1050, 'the oldest went');
    assert.equal(resumed[resumed.length - 1].createdAt, 1000 + many.length - 1, 'the rest in their original order');

    const store = fakeAsyncStorage({ 'outbox.big': 'x'.repeat(MAX_RESUMED_CHARS + 1), 'outbox.broken': '{not json' });
    assert.deepEqual(await outboxStorage('big', store).load(), []);
    assert.deepEqual(await outboxStorage('broken', store).load(), []);
    assert.deepEqual([...store.map.keys()], [], 'and neither is kept');
  });

  it('drops a retry only when a rule refuses it; any other failure costs an attempt', async () => {
    const event = signed(1);
    let failures = 0;
    const flaky: OutboxPublisher = {
      epoch: 0,
      check() {},
      publishItem: () => event,
      republish() {
        if (failures < 2) {
          failures += 1;
          throw new Error('socket is closing');
        }
      },
    };
    const outbox = new GroupOutbox({ retryDelay: quick, maxAttempts: 5 });
    outbox.attach(flaky);
    outbox.enqueue(chat(), { lobby: false }, flaky);
    await wait(60);
    assert.equal(failures, 2);
    assert.equal(outbox.pending.length, 1, 'kept through the failures');
    assert.equal(outbox.pending[0].attempts, 5, 'which cost attempts like any other');

    const strict: OutboxPublisher = {
      ...flaky,
      check() {
        throw new Refusal('not on this channel');
      },
    };
    outbox.detach(flaky);
    outbox.attach(strict);
    outbox.kick();
    await wait(20);
    assert.equal(outbox.pending.length, 0, 'a refusal drops it');
  });
});

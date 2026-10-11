import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelId, encryptPayload, generateSecretKey, NostrEvent, signEvent } from '../src/lib/nostr/crypto';
import { DEFAULT_INBOUND_BUDGET, MAX_FRAME_CHARS, MAX_PUBLISHED, MAX_SEEN, RelayPool } from '../src/lib/nostr/client';
import { encodeMessage, GROUP_EVENT_KIND, MAX_MEMO_CHARS, MAX_PSBT_CHARS } from '../src/lib/nostr/protocol';
import { makeFakeRelay } from './fakeRelay';

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A pool on the fake relay, subscribed to one channel, collecting what it
 * delivers. The fake relay fans out everything a peer sends, filter or not —
 * exactly what a misbehaving relay does.
 */
function listening(relay: ReturnType<typeof makeFakeRelay>, opts: ConstructorParameters<typeof RelayPool>[2] = {}) {
  const secret = generateSecretKey();
  const channel = channelId(secret);
  const pool = new RelayPool(['wss://fake'], relay.factory, opts);
  const delivered: NostrEvent[] = [];
  pool.connect({ onEvent: (e) => delivered.push(e) });
  pool.subscribe({ kinds: [GROUP_EVENT_KIND], '#t': [channel] });
  const wire = relay.factory();
  const author = generateSecretKey();
  const event = (overrides: Partial<NostrEvent> = {}, text = 'hi'): NostrEvent => ({
    ...signEvent(author, {
      created_at: Math.floor(Date.now() / 1000),
      kind: GROUP_EVENT_KIND,
      tags: [['t', channel]],
      content: encryptPayload(secret, encodeMessage({ type: 'chat', name: 'Rob', text })),
    }),
    ...overrides,
  });
  // What a client sends a relay is `['EVENT', event]`; the fake relay re-frames it as
  // `['EVENT', subId, event]` for the subscribers, the way a real one does.
  const send = (event: unknown) => wire.send(JSON.stringify(['EVENT', event]));
  return { secret, channel, pool, delivered, event, send };
}

describe('relay client: inbound bounds', () => {
  it('drops a frame over the size cap before parsing it, yet fits the largest honest event', async () => {
    const relay = makeFakeRelay();
    const l = listening(relay);
    await tick();

    // The largest thing a member legitimately sends: a PSBT at the cap, with a memo at the cap.
    const biggest = l.event({
      ...signEvent(generateSecretKey(), {
        created_at: Math.floor(Date.now() / 1000),
        kind: GROUP_EVENT_KIND,
        tags: [['t', l.channel]],
        content: encryptPayload(
          l.secret,
          encodeMessage({ type: 'psbt', base64: 'A'.repeat(MAX_PSBT_CHARS), memo: 'm'.repeat(MAX_MEMO_CHARS) })
        ),
      }),
    });
    const frame = JSON.stringify(['EVENT', 'sub', biggest]);
    assert.ok(frame.length <= MAX_FRAME_CHARS, `the largest honest frame (${frame.length}) must fit under the cap`);
    l.send(biggest);
    await tick();
    assert.equal(l.delivered.length, 1, 'delivered');

    // Over the cap is never even parsed.
    l.send({ ...l.event(), content: 'A'.repeat(MAX_FRAME_CHARS) });
    await tick();
    assert.equal(l.delivered.length, 1);
    assert.equal(l.pool.stats.oversized, 1);
    l.pool.close();
  });

  it('turns away events it did not ask for, and malformed ones, without verifying them', async () => {
    const relay = makeFakeRelay();
    const l = listening(relay);
    await tick();

    l.send(l.event({ kind: 1 })); // another kind
    l.send(l.event({ tags: [['t', channelId(generateSecretKey())]] })); // another channel
    l.send(l.event({ tags: [] })); // no channel
    l.send(l.event({ sig: 'ff'.repeat(64) })); // well-formed, bad signature
    l.send({ ...l.event(), id: 'short' });
    l.send({ ...l.event(), tags: 'nope' });
    l.send({ ...l.event(), content: 5 });
    l.send('not an object');
    await tick();
    assert.equal(l.delivered.length, 0);
    assert.equal(l.pool.stats.malformed, 8);

    l.send(l.event());
    await tick();
    assert.equal(l.delivered.length, 1, 'a well-formed event on our channel still arrives');
    l.pool.close();
  });

  it('accepts only so many events from one relay per window', async () => {
    const relay = makeFakeRelay();
    const l = listening(relay, { inboundBudget: { events: 5, windowMs: 60_000 } });
    await tick();

    const events = Array.from({ length: 8 }, (_, i) => l.event({}, `message ${i}`));
    for (const e of events) l.send(e);
    await tick();
    assert.equal(l.delivered.length, 5, 'the budget');
    assert.equal(l.pool.stats.throttled, 3);

    // A duplicate is turned away cheaply and never charged — so a relay
    // replaying the backlog cannot spend the budget.
    l.send(events[0]);
    await tick();
    assert.equal(l.delivered.length, 5);
    assert.equal(l.pool.stats.throttled, 3);
    l.pool.close();
  });

  it('has a sensible default budget', () => {
    // A subscription replays at most `limit` (500) stored events on connect.
    assert.ok(DEFAULT_INBOUND_BUDGET.events >= 500);
    assert.ok(DEFAULT_INBOUND_BUDGET.windowMs <= 5 * 60_000);
  });

  it('remembers only so many ids', async () => {
    const relay = makeFakeRelay();
    const l = listening(relay);
    await tick();
    // `publish` records ids without signing, so the caps can be reached quickly.
    for (let i = 0; i < MAX_SEEN + 10; i++) {
      l.pool.publish({ id: i.toString(16).padStart(64, '0'), pubkey: '', sig: '', kind: 1, created_at: 0, tags: [], content: '' });
    }
    const seen = (l.pool as any).seen as Set<string>;
    const published = (l.pool as any).published as Set<string>;
    assert.equal(seen.size, MAX_SEEN);
    assert.equal(published.size, MAX_PUBLISHED);
    assert.equal(seen.has('0'.repeat(64)), false, 'the oldest went first');
    assert.equal(seen.has((MAX_SEEN + 9).toString(16).padStart(64, '0')), true);
    l.pool.close();
  });
});

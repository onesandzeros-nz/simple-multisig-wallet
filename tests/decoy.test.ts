import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTACTS, initials } from '../src/lib/decoy/data';
import {
  IDLE_GAP_MS,
  appendMessage,
  inbox,
  inboxTime,
  lastMessage,
  markRead,
  refreshIdle,
  replyFor,
  seedState,
  threadFor,
} from '../src/lib/decoy/conversations';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

describe('decoy inbox', () => {
  it('seeds every contact with a conversation ordered by time', () => {
    const s = seedState(NOW);
    assert.equal(s.threads.length, CONTACTS.length);
    for (const t of s.threads) {
      assert.ok(t.messages.length > 0);
      for (let i = 1; i < t.messages.length; i++) assert.ok(t.messages[i].at >= t.messages[i - 1].at);
      assert.ok((lastMessage(t)?.at ?? Infinity) < NOW);
    }
    const order = inbox(s).map((t) => lastMessage(t)!.at);
    for (let i = 1; i < order.length; i++) assert.ok(order[i] <= order[i - 1], 'inbox is newest first');
  });

  it('answers sent messages in turn and cycles', () => {
    let s = seedState(NOW);
    s = appendMessage(s, 'dave', 'me', 'beers friday?', NOW);
    const dave = CONTACTS.find((c) => c.id === 'dave')!;
    const seen: string[] = [];
    for (let i = 0; i < dave.replies.length + 1; i++) {
      const r = replyFor(s, 'dave')!;
      seen.push(r.text);
      s = r.state;
    }
    assert.deepEqual(seen.slice(0, dave.replies.length), dave.replies);
    assert.equal(seen[dave.replies.length], dave.replies[0]);
  });

  it('notification numbers do not reply', () => {
    const s = seedState(NOW);
    assert.equal(replyFor(s, 'parcel'), null);
    assert.ok(replyFor(s, 'dental')?.text.includes('cannot receive replies'));
  });

  it('keeps quiet until the inbox has been idle, then someone gets in touch', () => {
    const s = seedState(NOW);
    assert.equal(refreshIdle(s, NOW + IDLE_GAP_MS / 2), s);
    const later = NOW + IDLE_GAP_MS + 60_000;
    const r = refreshIdle(s, later);
    const fresh = r.threads.filter((t) => t.unread);
    assert.equal(fresh.length, 1);
    const m = lastMessage(fresh[0])!;
    assert.equal(m.from, 'them');
    assert.ok(m.at > NOW && m.at < later);
    assert.equal(markRead(r, fresh[0].contactId).threads.every((t) => !t.unread), true);
    // A long absence brings a few, from different people, never more than three.
    const week = refreshIdle(s, NOW + 7 * 24 * 60 * 60 * 1000);
    const arrived = week.threads.filter((t) => t.unread);
    assert.equal(arrived.length, 3);
    assert.equal(new Set(arrived.map((t) => t.contactId)).size, 3);
  });

  it('unknown contacts get an empty thread rather than a crash', () => {
    assert.deepEqual(threadFor(seedState(NOW), 'nobody').messages, []);
  });

  it('formats inbox times', () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime();
    assert.equal(inboxTime(new Date(2026, 9, 1, 9, 5).getTime(), now), '9:05 am');
    assert.equal(inboxTime(new Date(2026, 8, 30, 23, 0).getTime(), now), 'Yesterday');
    assert.equal(inboxTime(new Date(2026, 8, 28, 12, 0).getTime(), now), 'Mon');
    assert.equal(inboxTime(new Date(2026, 8, 1, 12, 0).getTime(), now), '1 Sep');
  });

  it('makes initials', () => {
    assert.equal(initials('Mum'), 'M');
    assert.equal(initials('Dave Harrington'), 'DH');
    assert.equal(initials('Sam Whitfield Plumbing'), 'SP');
  });
});

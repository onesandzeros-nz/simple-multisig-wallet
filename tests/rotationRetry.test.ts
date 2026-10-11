import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_GRACE_MS, missingEpoch, RESEAL_GRACE_MS, silentOnEpoch } from '../src/lib/nostr/recovery';
import { GroupMessage } from '../src/lib/nostr/protocol';
import { ReceivedMessage } from '../src/lib/nostr/session';

const C = 'c'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let n = 0;
const msg = (author: string, at: number, message: GroupMessage, epoch: number, mine = false): ReceivedMessage => ({
  id: `m${n++}`,
  author,
  mine,
  at,
  epoch,
  message,
});
const began = 1_000_000;

describe('silentOnEpoch (coordinator reseals the unheard)', () => {
  const group = { coordinator: true, coordinatorPubkey: C, rekey: true, currentEpochAt: began, roster: [C, A, B] };

  it('names roster members not heard on the new epoch once the grace has passed', () => {
    const messages = [
      msg(C, began, { type: 'rekey-notice', epoch: 1 }, 0, true),
      msg(A, began + 5000, { type: 'key', name: 'Alice', keyExpression: '[x]xpub' }, 1),
      msg(B, began + 5000, { type: 'chat', name: 'Bob', text: 'still on the old key' }, 0),
    ];
    assert.deepEqual(silentOnEpoch(messages, group, 1, began + RESEAL_GRACE_MS - 1), [], 'not yet');
    assert.deepEqual(silentOnEpoch(messages, group, 1, began + RESEAL_GRACE_MS), [B]);
  });

  it('never names the coordinator, and does nothing on a legacy group or at epoch 0', () => {
    const late = began + RESEAL_GRACE_MS;
    assert.deepEqual(silentOnEpoch([], group, 1, late), [A, B]);
    assert.deepEqual(silentOnEpoch([], { ...group, rekey: undefined }, 1, late), []);
    assert.deepEqual(silentOnEpoch([], group, 0, late), []);
    assert.deepEqual(silentOnEpoch([], { ...group, currentEpochAt: undefined }, 1, late), [], 'unknown start');
    assert.deepEqual(silentOnEpoch([], { ...group, coordinator: false }, 1, late), []);
  });
});

describe('missingEpoch (member knocks for a lost envelope)', () => {
  const group = { coordinator: false, coordinatorPubkey: C, rekey: true };

  it('is the announced epoch this phone never received, once it has waited', () => {
    const messages = [msg(C, began, { type: 'rekey-notice', epoch: 2 }, 1)];
    assert.equal(missingEpoch(messages, group, 1, began + ENVELOPE_GRACE_MS - 1), null, 'still in flight');
    assert.equal(missingEpoch(messages, group, 1, began + ENVELOPE_GRACE_MS), 2);
    assert.equal(missingEpoch(messages, group, 2, began + ENVELOPE_GRACE_MS), null, 'already there');
  });

  it('only trusts the pinned coordinator, and the highest epoch announced', () => {
    const late = began + ENVELOPE_GRACE_MS;
    assert.equal(missingEpoch([msg(A, began, { type: 'rekey-notice', epoch: 2 }, 1)], group, 1, late), null);
    const two = [msg(C, began, { type: 'rekey-notice', epoch: 2 }, 1), msg(C, began, { type: 'rekey-notice', epoch: 3 }, 2)];
    assert.equal(missingEpoch(two, group, 1, late), 3);
    assert.equal(missingEpoch(two, { ...group, coordinator: true }, 1, late), null);
    assert.equal(missingEpoch(two, { ...group, rekey: undefined }, 1, late), null);
  });
});

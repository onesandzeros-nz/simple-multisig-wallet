import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { psbtReceipts } from '../src/lib/nostr/receipts';
import { GroupMessage } from '../src/lib/nostr/protocol';
import { ReceivedMessage } from '../src/lib/nostr/session';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const D = 'd'.repeat(64);
const TX = '1'.repeat(64);
let n = 0;
const msg = (author: string, at: number, message: GroupMessage, mine = false): ReceivedMessage => ({
  id: `m${n++}`,
  author,
  mine,
  at,
  epoch: 1,
  message,
});

describe('psbtReceipts', () => {
  it('reports which roster members have the transaction', () => {
    const receipts = psbtReceipts(
      [
        msg(A, 1, { type: 'join', name: 'Alice' }),
        msg(B, 2, { type: 'join', name: 'Bob' }),
        msg(D, 3, { type: 'join', name: 'Latecomer' }),
        msg(A, 4, { type: 'psbt-ack', txid: TX }),
        msg(B, 5, { type: 'psbt-ack', txid: '2'.repeat(64) }),
        msg(D, 6, { type: 'psbt-ack', txid: TX }),
      ],
      { roster: [A, B] },
      TX
    );
    assert.deepEqual(receipts, [
      { author: A, name: 'Alice', received: true },
      { author: B, name: 'Bob', received: false },
    ]);
  });

  it('is empty without a group or a transaction', () => {
    assert.deepEqual(psbtReceipts([msg(A, 1, { type: 'join', name: 'Alice' })], undefined, TX), []);
    assert.deepEqual(psbtReceipts([msg(A, 1, { type: 'join', name: 'Alice' })], { roster: [A] }, null), []);
  });
});

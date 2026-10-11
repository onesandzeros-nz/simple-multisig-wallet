import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memberAnswers } from '../src/lib/nostr/walletAnswers';
import { GroupMessage } from '../src/lib/nostr/protocol';
import { ReceivedMessage } from '../src/lib/nostr/session';

const C = 'c'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const OLD = 'wsh(sortedmulti(2,a,b,c))#old';
const NEW = 'wsh(sortedmulti(2,a,b,e))#new';

let n = 0;
const msg = (author: string, at: number, message: GroupMessage, mine = false): ReceivedMessage => ({
  id: `m${n++}`,
  author,
  mine,
  at,
  epoch: 1,
  message,
});
const join = (name: string): GroupMessage => ({ type: 'join', name, rekey: true });
const reply = (name: string, accepted: boolean, descriptor = NEW): GroupMessage => ({
  type: 'wallet-reply',
  name,
  accepted,
  descriptor,
});

describe('memberAnswers', () => {
  const group = { coordinatorPubkey: C, roster: [C, A, B, E] };

  it('reports each roster member as added, declined or waiting, latest answer winning', () => {
    const answers = memberAnswers(
      [
        msg(C, 1, join('Coordinator'), true),
        msg(A, 2, join('Alice')),
        msg(B, 3, join('Bob')),
        msg(E, 4, join('Eve')),
        msg(C, 5, { type: 'wallet', name: 'Vault', descriptor: NEW }, true),
        msg(A, 6, reply('Alice', true)),
        msg(B, 7, reply('Bob', true)),
        msg(B, 8, reply('Bob', false)),
      ],
      group
    );
    assert.deepEqual(answers, [
      { author: A, name: 'Alice', answer: 'added' },
      { author: B, name: 'Bob', answer: 'declined' },
      { author: E, name: 'Eve', answer: 'waiting' },
    ]);
  });

  it('only counts answers to the wallet currently shared', () => {
    const answers = memberAnswers(
      [
        msg(A, 1, join('Alice')),
        msg(C, 2, { type: 'wallet', name: 'Vault', descriptor: OLD }, true),
        msg(A, 3, reply('Alice', false, OLD)),
        msg(C, 4, { type: 'wallet', name: 'Vault', descriptor: NEW }, true),
      ],
      group
    );
    assert.deepEqual(answers, [{ author: A, name: 'Alice', answer: 'waiting' }]);
  });

  it('ignores a wallet from anyone but the pinned coordinator, and people outside the roster', () => {
    assert.equal(
      memberAnswers([msg(A, 1, join('Alice')), msg(A, 2, { type: 'wallet', name: 'Fake', descriptor: NEW })], group),
      null
    );
    const answers = memberAnswers(
      [
        msg(A, 1, join('Alice')),
        msg(D, 2, join('Latecomer')),
        msg(C, 3, { type: 'wallet', name: 'Vault', descriptor: NEW }, true),
        msg(D, 4, reply('Latecomer', true)),
      ],
      group
    );
    assert.deepEqual(answers, [{ author: A, name: 'Alice', answer: 'waiting' }]);
  });

  it('is null until a wallet has been shared, and empty when no one else has joined', () => {
    assert.equal(memberAnswers([msg(A, 1, join('Alice'))], group), null);
    assert.equal(memberAnswers([], undefined), null);
    assert.deepEqual(memberAnswers([msg(C, 1, { type: 'wallet', name: 'Vault', descriptor: NEW }, true)], group), []);
  });

  it('on a legacy group without a roster or pinned coordinator, everyone who joined counts', () => {
    const answers = memberAnswers(
      [
        msg(A, 1, join('Alice')),
        msg(D, 2, join('Dan')),
        msg(C, 3, { type: 'wallet', name: 'Vault', descriptor: NEW }, true),
        msg(D, 4, reply('Dan', true)),
      ],
      {}
    );
    assert.deepEqual(answers, [
      { author: A, name: 'Alice', answer: 'waiting' },
      { author: D, name: 'Dan', answer: 'added' },
    ]);
  });
});

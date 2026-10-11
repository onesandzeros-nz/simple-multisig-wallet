import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS, classifyMessage, isValidPin, makePinRecord, pinMatches } from '../src/lib/securityPin';

describe('security PIN', () => {
  it('accepts exactly six digits', () => {
    assert.equal(isValidPin('123456'), true);
    assert.equal(isValidPin('12345'), false);
    assert.equal(isValidPin('1234567'), false);
    assert.equal(isValidPin('12345a'), false);
    assert.equal(isValidPin(' 123456'), false);
  });

  it('hashes with a salt and never stores the digits', () => {
    const rec = makePinRecord('246810');
    assert.notEqual(rec.hash.includes('246810'), true);
    assert.equal(pinMatches('246810', rec), true);
    assert.equal(pinMatches('246811', rec), false);
    const other = makePinRecord('246810');
    assert.notEqual(rec.hash, other.hash, 'a fresh salt gives a fresh hash');
    assert.throws(() => makePinRecord('12'));
  });

  it('classifies chat messages, the PIN, and wrong PINs', () => {
    const rec = makePinRecord('900100');
    assert.deepEqual(classifyMessage('hey, you around?', rec, 0), { kind: 'chat' });
    assert.deepEqual(classifyMessage('12345', rec, 2), { kind: 'chat' }, 'five digits is not an attempt');
    assert.deepEqual(classifyMessage(' 900100 ', rec, 2), { kind: 'unlock' });
    assert.deepEqual(classifyMessage('111111', rec, 0), { kind: 'wrong', attempts: 1, wipe: false });
    assert.deepEqual(classifyMessage('111111', rec, MAX_ATTEMPTS - 1), {
      kind: 'wrong',
      attempts: MAX_ATTEMPTS,
      wipe: true,
    });
  });

  it('withholds a PIN-shaped message when there is no record to check it against', () => {
    // It may be the PIN itself — and a chat message is written to disk.
    assert.deepEqual(classifyMessage('123456', null, 0), { kind: 'withheld' });
    assert.deepEqual(classifyMessage(' 123456 ', null, 2), { kind: 'withheld' }, 'and it is not counted');
    assert.deepEqual(classifyMessage('hey', null, 0), { kind: 'chat' }, 'ordinary chat still goes through');
  });
});

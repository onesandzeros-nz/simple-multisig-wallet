import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_KEYS,
  cosignerInstructions,
  planKeys,
  policyTradeoffs,
  recommendPolicy,
  slotLabels,
} from '../src/lib/tutorialPolicy';
import { KeyPlanSlot, Owners, PolicyAnswers } from '../src/lib/types';

function answers(
  owners: Owners,
  hardwareDevices: PolicyAnswers['hardwareDevices'],
  stakes: PolicyAnswers['stakes'],
  people = owners === 'me' ? 1 : owners === 'pair' ? 2 : 3
): PolicyAnswers {
  return { owners, people, hardwareDevices, stakes };
}

const kinds = (slots: KeyPlanSlot[]) => slots.map((s) => s.kind);

/** The people count recommendPolicy settles on before planning. */
function normalisedPeople(a: PolicyAnswers): number {
  if (a.owners === 'me') return 1;
  if (a.owners === 'pair') return 2;
  return Math.min(MAX_KEYS, Math.max(3, Math.round(a.people)));
}

function checkPlan(a: PolicyAnswers, n: number) {
  const slots = planKeys(a, n);
  const label = `${JSON.stringify(a)} n=${n}`;
  assert.equal(slots.length, n, label);
  assert.equal(slots.filter((s) => s.kind === 'this-phone').length, 1, label);
  assert.equal(slots[0].kind, 'this-phone', label);
  assert.equal(slots[0].where, 'this-phone', label);
  const others = slots.filter((s) => s.kind === 'other-phone');
  assert.ok(others.length <= Math.min(a.people - 1, n - 1), label);
  if (a.owners === 'me') assert.equal(others.length, 0, label);
  others.forEach((s, i) => {
    assert.equal(s.person, i + 2, label);
    assert.equal(s.where, 'other-person', label);
  });
  assert.ok(slots.every((s) => s.keyId === undefined), label);
  assert.ok(slots.every((s) => !('keyId' in s)), label);
  // Hardware the user owns comes before hardware still to acquire; the first owned one lives at home.
  const hardware = slots.filter((s) => s.kind === 'hardware');
  const owned = hardware.filter((s) => !s.toAcquire);
  assert.ok(owned.length <= a.hardwareDevices, label);
  owned.forEach((s, i) => assert.equal(s.where, i === 0 ? 'home' : 'elsewhere', label));
  const firstToAcquire = hardware.findIndex((s) => s.toAcquire);
  if (firstToAcquire >= 0) {
    assert.ok(hardware.slice(firstToAcquire).every((s) => s.toAcquire && s.where === 'elsewhere'), label);
  }
}

describe('recommendPolicy', () => {
  it('one person with no hardware yet: 2 of 3, two signers to acquire, phone-only warning', () => {
    const rec = recommendPolicy(answers('me', 0, 'modest'));
    assert.equal(rec.m, 2);
    assert.equal(rec.n, 3);
    assert.deepEqual(rec.slots, [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'hardware', where: 'elsewhere', toAcquire: true },
      { kind: 'hardware', where: 'elsewhere', toAcquire: true },
    ]);
    assert.deepEqual(rec.warnings, [
      'Every key you have today would live on a phone. Get at least one hardware signer before putting real money here — until then keep the wallet small, or practise with test coins.',
    ]);
    assert.deepEqual(rec.reasons, [
      'Any 2 of the 3 keys can spend, so you can lose one key — a fire, a theft, a broken device — and still reach your money.',
      'A thief needs 2 keys kept in different places. One stolen phone or one stolen device is useless on its own.',
      'Three keys is the smallest set that gives you both of those.',
    ]);
  });

  it('one person with one hardware signer and real savings: 2 of 3, hardware at home', () => {
    const rec = recommendPolicy(answers('me', 1, 'serious'));
    assert.equal(rec.m, 2);
    assert.equal(rec.n, 3);
    assert.deepEqual(rec.slots, [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'hardware', where: 'home' },
      { kind: 'hardware', where: 'elsewhere', toAcquire: true },
    ]);
    assert.ok(!rec.warnings.some((w) => w.includes('Every key you have today would live on a phone')));
    assert.deepEqual(rec.warnings, []);
    assert.ok(
      rec.reasons.includes(
        'Your hardware signer holds the key that matters; the phone key is for convenience and the third key is insurance.'
      )
    );
  });

  it('a couple with one hardware signer: 2 of 3 with the partner holding key 2', () => {
    const rec = recommendPolicy(answers('pair', 1, 'modest'));
    assert.equal(rec.m, 2);
    assert.equal(rec.n, 3);
    assert.deepEqual(rec.slots, [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'other-phone', where: 'other-person', person: 2 },
      { kind: 'hardware', where: 'home' },
    ]);
    assert.ok(rec.reasons.some((r) => r.includes('whoever holds two can spend alone')));
    assert.equal(
      rec.reasons[3],
      'With two people and three keys, whoever holds two can spend alone. Keep the third key somewhere neither of you carries around — a safe at home, or with a trusted relative.'
    );
    assert.deepEqual(rec.warnings, []);
  });

  it('a couple with real savings and no hardware gets the offline-key warning', () => {
    const rec = recommendPolicy(answers('pair', 0, 'serious'));
    assert.deepEqual(rec.warnings, [
      'Real savings deserve at least one key that never touches an internet-connected phone.',
    ]);
  });

  it('three people with pocket money: 2 of 3, one key each', () => {
    const rec = recommendPolicy(answers('group', 0, 'modest', 3));
    assert.equal(rec.m, 2);
    assert.equal(rec.n, 3);
    assert.deepEqual(rec.slots, [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'other-phone', where: 'other-person', person: 2 },
      { kind: 'other-phone', where: 'other-person', person: 3 },
    ]);
    assert.deepEqual(rec.warnings, []);
  });

  it('three people with real savings: 3 of 5 with two spare keys', () => {
    const rec = recommendPolicy(answers('group', 0, 'serious', 3));
    assert.equal(rec.m, 3);
    assert.equal(rec.n, 5);
    assert.deepEqual(kinds(rec.slots), ['this-phone', 'other-phone', 'other-phone', 'hardware', 'hardware']);
    assert.equal(rec.slots.filter((s) => s.toAcquire).length, 2);
    assert.equal(
      rec.reasons[0],
      'Any 3 of the 5 keys can spend, so you can lose 2 keys — a fire, a theft, a broken device — and still reach your money.'
    );
    assert.equal(rec.reasons[2], 'Five keys lets 3 people each hold one and leaves 2 spare.');
    assert.deepEqual(rec.warnings, [
      'Real savings deserve at least one key that never touches an internet-connected phone.',
    ]);
  });

  it('four people with pocket money: 3 of 5 with one signer to acquire', () => {
    const rec = recommendPolicy(answers('group', 0, 'modest', 4));
    assert.equal(rec.m, 3);
    assert.equal(rec.n, 5);
    assert.deepEqual(kinds(rec.slots), ['this-phone', 'other-phone', 'other-phone', 'other-phone', 'hardware']);
    assert.equal(rec.slots.filter((s) => s.toAcquire).length, 1);
    assert.equal(rec.reasons[2], 'Five keys lets 4 people each hold one and leaves 1 spare.');
  });

  it('seven people: 3 of 5, four other phones, and a warning about more than five keys', () => {
    const rec = recommendPolicy(answers('group', 0, 'modest', 7));
    assert.equal(rec.m, 3);
    assert.equal(rec.n, 5);
    assert.equal(rec.slots.filter((s) => s.kind === 'other-phone').length, 4);
    assert.deepEqual(
      rec.slots.filter((s) => s.kind === 'other-phone').map((s) => s.person),
      [2, 3, 4, 5]
    );
    assert.equal(rec.slots.filter((s) => s.toAcquire).length, 0);
    assert.equal(rec.reasons[2], 'Five keys lets 5 people each hold one.');
    assert.deepEqual(rec.warnings, [
      'More than five keys gets hard to manage. Give keys to five of the 7 people and let the rest watch the wallet.',
    ]);
  });

  it('never recommends anything but 2 of 3 or 3 of 5, and plans keys consistently', () => {
    const owners: Owners[] = ['me', 'pair', 'group'];
    const hardware: PolicyAnswers['hardwareDevices'][] = [0, 1, 2, 3];
    const stakes: PolicyAnswers['stakes'][] = ['modest', 'serious'];
    let seen = 0;
    for (const o of owners) {
      for (const h of hardware) {
        for (const s of stakes) {
          for (let people = 1; people <= MAX_KEYS; people++) {
            const a: PolicyAnswers = { owners: o, people, hardwareDevices: h, stakes: s };
            const rec = recommendPolicy(a);
            const pair = `${rec.m}-of-${rec.n}`;
            assert.ok(pair === '2-of-3' || pair === '3-of-5', `${JSON.stringify(a)} → ${pair}`);
            assert.notEqual(rec.m, rec.n);
            assert.notEqual(rec.m, 1);
            assert.equal(rec.slots.length, rec.n);
            assert.deepEqual(rec.slots, planKeys({ ...a, people: normalisedPeople(a) }, rec.n));
            assert.ok(rec.reasons.length >= 3);

            assert.equal(rec.alternatives.length, 2);
            assert.ok(rec.alternatives.every((alt) => !(alt.m === rec.m && alt.n === rec.n)));
            const twoOfTwo = rec.alternatives.find((alt) => alt.m === 2 && alt.n === 2);
            assert.ok(twoOfTwo);
            assert.equal(twoOfTwo.when, 'not recommended — if either key is lost the money is stuck');

            for (let n = 2; n <= MAX_KEYS; n++) checkPlan(a, n);
            seen++;
          }
        }
      }
    }
    assert.equal(seen, 3 * 4 * 2 * MAX_KEYS);
  });

  it('lists the other recommended policy as an alternative', () => {
    const small = recommendPolicy(answers('me', 0, 'modest'));
    assert.deepEqual(small.alternatives, [
      { m: 3, n: 5, when: 'four or more people, or two spare keys for serious savings' },
      { m: 2, n: 2, when: 'not recommended — if either key is lost the money is stuck' },
    ]);
    const big = recommendPolicy(answers('group', 0, 'serious', 3));
    assert.deepEqual(big.alternatives, [
      { m: 2, n: 3, when: 'the usual choice for one person or a couple' },
      { m: 2, n: 2, when: 'not recommended — if either key is lost the money is stuck' },
    ]);
  });
});

describe('planKeys', () => {
  it('re-plans for any key count the override allows', () => {
    const a = answers('pair', 2, 'serious');
    assert.deepEqual(planKeys(a, 2), [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'other-phone', where: 'other-person', person: 2 },
    ]);
    assert.deepEqual(planKeys(a, 5), [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'other-phone', where: 'other-person', person: 2 },
      { kind: 'hardware', where: 'home' },
      { kind: 'hardware', where: 'elsewhere' },
      { kind: 'hardware', where: 'elsewhere', toAcquire: true },
    ]);
  });

  it('caps other people at n - 1 and never adds a second key on this phone', () => {
    const slots = planKeys(answers('group', 3, 'serious', 9), 4);
    assert.deepEqual(kinds(slots), ['this-phone', 'other-phone', 'other-phone', 'other-phone']);
    assert.equal(slots.filter((s) => s.kind === 'this-phone').length, 1);
  });

  it('owned hardware fills before signers still to acquire', () => {
    const slots = planKeys(answers('me', 3, 'serious'), 5);
    assert.deepEqual(slots, [
      { kind: 'this-phone', where: 'this-phone' },
      { kind: 'hardware', where: 'home' },
      { kind: 'hardware', where: 'elsewhere' },
      { kind: 'hardware', where: 'elsewhere' },
      { kind: 'hardware', where: 'elsewhere', toAcquire: true },
    ]);
  });
});

describe('policyTradeoffs', () => {
  it('all-keys-needed policies are dangerous', () => {
    for (const [m, n] of [
      [2, 2],
      [5, 5],
    ]) {
      const t = policyTradeoffs(m, n);
      assert.equal(t.tone, 'danger');
      assert.equal(t.canLose, 0);
      assert.equal(t.thiefNeeds, m);
      assert.equal(t.lines.length, 1);
      assert.ok(t.lines[0].includes('gone for good'));
    }
    assert.equal(
      policyTradeoffs(2, 2).lines[0],
      'All 2 keys are needed to spend. Lose any one of them and the money is gone for good.'
    );
  });

  it('a threshold of one is not really multisig', () => {
    const t = policyTradeoffs(1, 3);
    assert.equal(t.tone, 'danger');
    assert.equal(t.thiefNeeds, 1);
    assert.deepEqual(t.lines, [
      'Any single key can spend on its own — one stolen key and the money is gone. This is not really multisig.',
    ]);
    assert.ok(t.lines[0].includes('not really multisig'));
  });

  it('2 of 3 and 3 of 5 read as a success', () => {
    const small = policyTradeoffs(2, 3);
    assert.equal(small.tone, 'success');
    assert.equal(small.canLose, 1);
    assert.equal(small.thiefNeeds, 2);
    assert.ok(small.lines[0].includes('losing 2 loses the money'));
    assert.deepEqual(small.lines, [
      'You can lose 1 key and still spend; losing 2 loses the money for good.',
      'A thief needs 2 keys.',
    ]);

    const big = policyTradeoffs(3, 5);
    assert.equal(big.tone, 'success');
    assert.equal(big.canLose, 2);
    assert.equal(big.thiefNeeds, 3);
    assert.deepEqual(big.lines, [
      'You can lose 2 keys and still spend; losing 3 loses the money for good.',
      'A thief needs 3 keys.',
    ]);
  });

  it('low thresholds and many keys carry a warning', () => {
    const loose = policyTradeoffs(2, 5);
    assert.equal(loose.tone, 'warning');
    assert.equal(loose.canLose, 3);
    assert.ok(loose.lines.some((l) => l.includes('easier to steal')));
    assert.equal(loose.lines[2], 'Only 2 of 5 needed — easy to recover, but easier to steal than it looks.');
    assert.ok(!loose.lines.some((l) => l.includes('recovery phrases')));

    const many = policyTradeoffs(2, 7);
    assert.equal(many.tone, 'warning');
    assert.ok(many.lines.some((l) => l.includes('7 recovery phrases')));
    assert.equal(many.lines[3], '7 keys means 7 recovery phrases to keep safe.');

    const tightButMany = policyTradeoffs(5, 7);
    assert.equal(tightButMany.tone, 'warning');
    assert.deepEqual(tightButMany.lines, [
      'You can lose 2 keys and still spend; losing 3 loses the money for good.',
      'A thief needs 5 keys.',
      '7 keys means 7 recovery phrases to keep safe.',
    ]);
  });

  it('impossible policies fall back to a single instruction', () => {
    for (const [m, n] of [
      [0, 1],
      [0, 3],
      [3, 2],
      [1, 1],
    ]) {
      const t = policyTradeoffs(m, n);
      assert.equal(t.tone, 'danger', `${m} of ${n}`);
      assert.equal(t.canLose, 0);
      assert.equal(t.thiefNeeds, m);
      assert.deepEqual(t.lines, [
        'Pick at least two keys and a threshold between 1 and the number of keys.',
      ]);
    }
  });
});

describe('slotLabels', () => {
  it('numbers keys from one and names each kind', () => {
    const phone = slotLabels({ kind: 'this-phone', where: 'this-phone' }, 0);
    assert.equal(phone.title, 'Key 1 · This phone');
    assert.equal(phone.icon, 'phone-portrait-outline');
    assert.equal(phone.hint, 'Your everyday signer. Created in this app; write its 12 words on paper.');

    const other = slotLabels({ kind: 'other-phone', where: 'other-person', person: 3 }, 2);
    assert.equal(other.title, "Key 3 · Person 3's key");
    assert.equal(other.icon, 'people-outline');
    assert.ok(other.hint.includes('Share public key or Show as QR'));

    const home = slotLabels({ kind: 'hardware', where: 'home' }, 1);
    assert.equal(home.title, 'Key 2 · Hardware signer');
    assert.equal(home.icon, 'hardware-chip-outline');
    assert.equal(home.hint, 'Kept at home, offline. Import its public key by QR, file, NFC or TAPSIGNER tap.');

    const elsewhere = slotLabels({ kind: 'hardware', where: 'elsewhere' }, 3);
    assert.equal(elsewhere.title, 'Key 4 · Hardware signer');
    assert.equal(
      elsewhere.hint,
      "Kept somewhere else — a relative's house or a bank box. Import its public key by QR, file, NFC or TAPSIGNER tap."
    );
  });

  it('a signer still to acquire is never a second key on this phone', () => {
    const label = slotLabels({ kind: 'hardware', where: 'elsewhere', toAcquire: true }, 4);
    assert.equal(label.title, "Key 5 · A signer you don't have yet");
    assert.equal(label.icon, 'hardware-chip-outline');
    assert.ok(label.hint.includes('Never a second key on this phone'));
    assert.equal(
      label.hint,
      'A hardware wallet (Coldcard, TAPSIGNER, SeedSigner, Jade…) or a key made in this app on a second phone kept somewhere else. Never a second key on this phone.'
    );
  });

  it('labels every slot of a recommended plan', () => {
    const rec = recommendPolicy(answers('group', 1, 'serious', 4));
    const titles = rec.slots.map((s, i) => slotLabels(s, i).title);
    assert.deepEqual(titles, [
      'Key 1 · This phone',
      "Key 2 · Person 2's key",
      "Key 3 · Person 3's key",
      "Key 4 · Person 4's key",
      'Key 5 · Hardware signer',
    ]);
  });
});

describe('cosignerInstructions', () => {
  const stepNumbers = (msg: string) => [...msg.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));

  it('walks the other person from installing to sharing the public key', () => {
    const msg = cosignerInstructions({ testnet: false });
    assert.match(msg, /Install Simple Multisig/);
    assert.match(msg, /Create a key on this phone/);
    assert.match(msg, /Share public key/);
    assert.match(msg, /never spend/i);
    assert.doesNotMatch(msg, /testnet/i);
    assert.deepEqual(stepNumbers(msg), [1, 2, 3, 4]);
    assert.ok(msg.length < 900, `${msg.length} chars`);
  });

  it('puts the testnet step before the key is made, and renumbers', () => {
    const msg = cosignerInstructions({ testnet: true });
    assert.match(msg, /Testnet mode/);
    assert.ok(msg.indexOf('Testnet mode') < msg.indexOf('Create a key on this phone'));
    assert.deepEqual(stepNumbers(msg), [1, 2, 3, 4, 5]);
    assert.ok(msg.length < 900, `${msg.length} chars`);
  });
});

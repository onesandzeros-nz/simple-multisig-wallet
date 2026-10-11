import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitKeyCandidates } from '../src/lib/keyCandidates';

describe('splitKeyCandidates', () => {
  it("puts other members' keys apart from this phone's, keeping each group's order", () => {
    const { remote, local } = splitKeyCandidates([
      { key: 'alice', mine: false },
      { key: 'mine-1', mine: true },
      { key: 'bob', mine: false },
      { key: 'mine-2', mine: true },
    ]);
    assert.deepEqual(
      remote.map((c) => c.key),
      ['alice', 'bob']
    );
    assert.deepEqual(
      local.map((c) => c.key),
      ['mine-1', 'mine-2']
    );
  });

  it('handles an empty list and lists with only one kind', () => {
    assert.deepEqual(splitKeyCandidates([]), { remote: [], local: [] });
    assert.deepEqual(splitKeyCandidates([{ mine: true }]), { remote: [], local: [{ mine: true }] });
    assert.deepEqual(splitKeyCandidates([{ mine: false }]), { remote: [{ mine: false }], local: [] });
  });
});

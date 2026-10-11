import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { decodeCbor, encodeCbor, Tagged } from '../src/lib/cbor';
import { parseCardResponse } from '../src/lib/tapsigner';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('CBOR decoding', () => {
  it('decodes RFC 8949 integer vectors', () => {
    assert.equal(decodeCbor(hex('00')), 0);
    assert.equal(decodeCbor(hex('17')), 23);
    assert.equal(decodeCbor(hex('1818')), 24);
    assert.equal(decodeCbor(hex('1903e8')), 1000);
    assert.equal(decodeCbor(hex('1a000f4240')), 1000000);
    assert.equal(decodeCbor(hex('1b000000e8d4a51000')), 1000000000000); // 8-byte length
    assert.equal(decodeCbor(hex('20')), -1);
    assert.equal(decodeCbor(hex('3903e7')), -1000);
  });

  it('decodes definite strings, arrays, maps and simple values', () => {
    assert.equal(decodeCbor(hex('6449455446')), 'IETF');
    assert.deepEqual(decodeCbor(hex('4401020304')), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(decodeCbor(hex('83010203')), [1, 2, 3]);
    assert.deepEqual(decodeCbor(hex('a201020304')), new Map([[1, 2], [3, 4]]));
    assert.equal(decodeCbor(hex('f4')), false);
    assert.equal(decodeCbor(hex('f5')), true);
    assert.equal(decodeCbor(hex('f6')), null);
  });

  // The failure seen on a real TAPSIGNER: the card emits indefinite-length
  // items (0xbf map … 0xff) rather than counted ones.
  it('decodes indefinite-length maps', () => {
    // bf 61 61 01 61 62 02 ff  => {"a": 1, "b": 2}
    const decoded = decodeCbor(hex('bf 6161 01 6162 02 ff'));
    assert.deepEqual(decoded, new Map([['a', 1], ['b', 2]]));
  });

  it('decodes indefinite-length arrays, byte strings and text', () => {
    assert.deepEqual(decodeCbor(hex('9f010203ff')), [1, 2, 3]);
    assert.deepEqual(decodeCbor(hex('5f42010243030405ff')), Buffer.from([1, 2, 3, 4, 5]));
    assert.equal(decodeCbor(hex('7f657374726561646d696e67ff')), 'streaming');
  });

  it('decodes nested indefinite structures', () => {
    // {"x": [1, {"y": h'ab'}]} with every container indefinite
    const bytes = hex('bf 6178 9f 01 bf 6179 41ab ff ff ff');
    const decoded = decodeCbor(bytes);
    const inner = decoded.get('x');
    assert.equal(inner[0], 1);
    assert.deepEqual(inner[1].get('y'), Buffer.from([0xab]));
  });

  it('rejects truncated and malformed data', () => {
    assert.throws(() => decodeCbor(hex('bf 6161 01')), /Unexpected end/i);
    assert.throws(() => decodeCbor(hex('4405')), /Unexpected end/i);
    assert.throws(() => decodeCbor(hex('1c')), /Malformed CBOR length/i);
  });

  it('round-trips everything the encoder produces', () => {
    const value = new Tagged(
      401,
      new Map<any, any>([
        [1, 2],
        [2, [Buffer.from('aabb', 'hex'), 'text', true]],
      ])
    );
    assert.deepEqual(decodeCbor(encodeCbor(value)), value);
  });
});

describe('TAPSIGNER responses using indefinite CBOR', () => {
  it('parses an indefinite-length status response', () => {
    // What the card actually sends: bf … ff, then the 9000 status word.
    const body = hex(
      'bf' +
        '65' + Buffer.from('proto').toString('hex') + '01' +
        '63' + Buffer.from('ver').toString('hex') + '65' + Buffer.from('1.0.3').toString('hex') +
        '69' + Buffer.from('tapsigner').toString('hex') + 'f5' +
        'ff'
    );
    const response = parseCardResponse(Uint8Array.from(Buffer.concat([body, hex('9000')])));
    assert.equal(response.get('proto'), 1);
    assert.equal(response.get('ver'), '1.0.3');
    assert.equal(response.get('tapsigner'), true);
  });

  it('surfaces an indefinite-length error response', () => {
    const body = hex(
      'bf' +
        '65' + Buffer.from('error').toString('hex') + '68' + Buffer.from('bad auth').toString('hex') +
        '64' + Buffer.from('code').toString('hex') + '190191' +
        'ff'
    );
    assert.throws(
      () => parseCardResponse(Uint8Array.from(Buffer.concat([body, hex('9000')]))),
      /Incorrect PIN/i
    );
  });
});

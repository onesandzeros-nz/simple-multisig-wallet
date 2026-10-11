import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { decodeMessage, encodeMessage, encodeVarint, MessageSchema } from '../src/lib/hw/protobuf';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('protobuf wire format', () => {
  // The worked examples from protobuf.dev/programming-guides/encoding.
  it('encodes the documented examples byte for byte', () => {
    assert.equal(hex(encodeMessage({ a: { id: 1, type: 'int32' } }, { a: 150 })), '089601');
    assert.equal(hex(encodeMessage({ b: { id: 2, type: 'string' } }, { b: 'testing' })), '120774657374696e67');
    const inner: MessageSchema = { a: { id: 1, type: 'int32' } };
    assert.equal(hex(encodeMessage({ c: { id: 3, type: inner } }, { c: { a: 150 } })), '1a03089601');
    assert.equal(
      hex(encodeMessage({ f: { id: 6, type: 'int32', repeated: true, packed: true } }, { f: [3, 270, 86942] })),
      '3206038e029ea705'
    );
  });

  it('writes repeated scalars unpacked unless asked to pack them', () => {
    // proto2, as Trezor speaks it: one tag per element.
    const schema: MessageSchema = { address_n: { id: 1, type: 'uint32', repeated: true } };
    assert.equal(hex(encodeMessage(schema, { address_n: [0x80000030, 1] })), '08b0808080080801');
  });

  it('reads repeated scalars in either form', () => {
    const schema: MessageSchema = { n: { id: 1, type: 'uint32', repeated: true } };
    assert.deepEqual(decodeMessage(schema, Buffer.from('08b0808080080801', 'hex')).n, [0x80000030, 1]);
    assert.deepEqual(decodeMessage(schema, Buffer.from('0a06b08080800801', 'hex')).n, [0x80000030, 1]);
  });

  it('round-trips every field type', () => {
    const point: MessageSchema = { x: { id: 1, type: 'sint32' }, y: { id: 2, type: 'sint64' } };
    const schema: MessageSchema = {
      flag: { id: 1, type: 'bool' },
      small: { id: 2, type: 'uint32' },
      sats: { id: 3, type: 'uint64' },
      signed: { id: 4, type: 'int32' },
      kind: { id: 5, type: 'enum' },
      label: { id: 6, type: 'string' },
      blob: { id: 7, type: 'bytes' },
      point: { id: 8, type: point },
      points: { id: 9, type: point, repeated: true },
      names: { id: 10, type: 'string', repeated: true },
    };
    const message = {
      flag: true,
      small: 0xffffffff,
      sats: 2_100_000_000_000_000, // every bitcoin there will ever be, in sats
      signed: -7,
      kind: 3,
      label: 'Savings ₿',
      blob: Buffer.from('00ff10', 'hex'),
      point: { x: -1, y: -123456789012 },
      points: [{ x: 1, y: 2 }, { x: -3, y: 4 }],
      names: ['a', 'b'],
    };
    assert.deepEqual(decodeMessage(schema, encodeMessage(schema, message)), message);
  });

  it('keeps an explicit zero, and leaves out what is undefined', () => {
    const schema: MessageSchema = { a: { id: 1, type: 'uint32' }, b: { id: 2, type: 'uint32' } };
    assert.equal(hex(encodeMessage(schema, { a: 0 })), '0800');
    const back = decodeMessage(schema, Buffer.from('0800', 'hex'));
    assert.equal(back.a, 0);
    assert.equal(back.b, undefined);
  });

  it('always returns a list for a repeated field', () => {
    const schema: MessageSchema = { n: { id: 1, type: 'uint32', repeated: true } };
    assert.deepEqual(decodeMessage(schema, new Uint8Array(0)).n, []);
  });

  it('skips fields it does not know, of any wire type', () => {
    const schema: MessageSchema = { b: { id: 2, type: 'uint32' } };
    // 1: varint, 3: bytes, 4: fixed64, 5: fixed32 — then the one we want.
    const bytes = Buffer.from('0801' + '1a02beef' + '21' + '00'.repeat(8) + '2d' + '00'.repeat(4) + '102a', 'hex');
    assert.deepEqual(decodeMessage(schema, bytes), { b: 42 });
  });

  it('refuses a field name the schema does not have', () => {
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'uint32' } }, { b: 1 }), /Unknown field "b"/);
  });

  it('refuses values that do not fit their type', () => {
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'uint32' } }, { a: -1 }), /non-negative/);
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'uint32' } }, { a: 2 ** 32 }), /32 bits/);
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'uint64' } }, { a: 1.5 }), /whole number/);
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'bytes' } }, { a: 'text' }), /bytes/);
    assert.throws(() => encodeMessage({ a: { id: 1, type: 'string' } }, { a: 5 }), /text/);
  });

  it('refuses truncated and malformed input', () => {
    const schema: MessageSchema = { a: { id: 1, type: 'bytes' } };
    assert.throws(() => decodeMessage(schema, Buffer.from('0a05aabb', 'hex')), /Truncated/);
    assert.throws(() => decodeMessage(schema, Buffer.from('0a', 'hex')), /Truncated/);
    assert.throws(() => decodeMessage(schema, Buffer.from('08' + 'ff'.repeat(11), 'hex')), /varint too long/);
    assert.throws(() => decodeMessage(schema, Buffer.from('0b', 'hex')), /wire type/);
  });

  it('refuses a number too large to handle exactly', () => {
    const schema: MessageSchema = { a: { id: 1, type: 'uint64' } };
    assert.throws(() => decodeMessage(schema, Buffer.from('08ffffffffffffffffff01', 'hex')), /too large/);
  });

  it('stops at a message nested implausibly deep', () => {
    const self: MessageSchema = {};
    self.next = { id: 1, type: () => self };
    let bytes = Buffer.alloc(0);
    for (let i = 0; i < 40; i++) bytes = Buffer.concat([Buffer.from([0x0a]), Buffer.from(encodeVarint(bytes.length)), bytes]);
    assert.throws(() => decodeMessage(self, bytes), /nested too deeply/);
  });

  it('does not alias the buffer it decoded from', () => {
    const schema: MessageSchema = { a: { id: 1, type: 'bytes' } };
    const wire = Buffer.from('0a02beef', 'hex');
    const decoded = decodeMessage(schema, wire);
    wire.fill(0);
    assert.equal(hex(decoded.a), 'beef');
    assert.ok(Buffer.isBuffer(decoded.a));
  });

  it('encodes varints', () => {
    assert.equal(hex(encodeVarint(0)), '00');
    assert.equal(hex(encodeVarint(300)), 'ac02');
    assert.throws(() => encodeVarint(-1));
  });
});

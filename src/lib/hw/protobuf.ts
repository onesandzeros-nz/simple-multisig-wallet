import { Buffer } from 'buffer';

/**
 * Protocol Buffers wire format — the small part Trezor and BitBox02 messages
 * need. Schemas are written out by hand next to the code that uses them, so
 * nothing is generated and nothing is parsed at runtime.
 *
 * Reference: protobuf.dev/programming-guides/encoding
 */

export type ScalarType =
  | 'uint32'
  | 'uint64'
  | 'int32'
  | 'int64'
  | 'sint32'
  | 'sint64'
  | 'bool'
  | 'enum'
  | 'string'
  | 'bytes';

export interface FieldSpec {
  id: number;
  /** A scalar, or the schema of a nested message (a function, for schemas that refer to themselves). */
  type: ScalarType | MessageSchema | (() => MessageSchema);
  repeated?: boolean;
  /**
   * Repeated scalars only: write them as one length-delimited run. proto3
   * (BitBox02) does this by default, proto2 (Trezor) does not. Reading accepts
   * either form whatever this says.
   */
  packed?: boolean;
}

/** Field name → where and how it travels. */
export type MessageSchema = Record<string, FieldSpec>;

/** Decoded message: absent fields are undefined, repeated fields are always arrays. */
export type Message = Record<string, any>;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

/** Nesting deeper than any real message, shallow enough that a hostile one cannot exhaust the stack. */
const MAX_DEPTH = 16;

// ---------------------------------------------------------------------------
// Varints
// ---------------------------------------------------------------------------

function pushVarint(out: number[], value: bigint): void {
  let v = BigInt.asUintN(64, value);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

/** Varint for a non-negative safe integer. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Cannot encode ${value} as a varint.`);
  const out: number[] = [];
  pushVarint(out, BigInt(value));
  return Uint8Array.from(out);
}

function readVarint(bytes: Uint8Array, at: number): { value: bigint; next: number } {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (at + i >= bytes.length) throw new Error('Truncated message.');
    const b = bytes[at + i];
    value |= BigInt(b & 0x7f) << BigInt(7 * i);
    if ((b & 0x80) === 0) return { value: BigInt.asUintN(64, value), next: at + i + 1 };
  }
  throw new Error('Malformed message (varint too long).');
}

function toNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`The ${what} value is too large to handle safely.`);
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function schemaOf(type: FieldSpec['type']): MessageSchema | null {
  if (typeof type === 'string') return null;
  return typeof type === 'function' ? type() : type;
}

function scalarToVarint(type: ScalarType, value: any, name: string): bigint {
  switch (type) {
    case 'bool':
      return value ? 1n : 0n;
    case 'uint32':
    case 'uint64':
      if (typeof value === 'bigint') {
        if (value < 0n) throw new Error(`Field "${name}" cannot be negative.`);
        return value;
      }
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Field "${name}" must be a non-negative whole number.`);
      }
      if (type === 'uint32' && value > 0xffffffff) throw new Error(`Field "${name}" does not fit in 32 bits.`);
      return BigInt(value);
    case 'int32':
    case 'int64':
    case 'enum':
      if (!Number.isSafeInteger(value)) throw new Error(`Field "${name}" must be a whole number.`);
      // Negative values travel as their 64-bit two's complement.
      return BigInt.asUintN(64, BigInt(value));
    case 'sint32':
    case 'sint64': {
      if (!Number.isSafeInteger(value)) throw new Error(`Field "${name}" must be a whole number.`);
      const v = BigInt(value);
      return BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)); // zigzag
    }
    default:
      throw new Error(`Field "${name}" is not a number type.`);
  }
}

function encodeField(out: number[], name: string, spec: FieldSpec, value: any, depth: number): void {
  const nested = schemaOf(spec.type);
  if (nested) {
    const body = encodeAt(nested, value, depth + 1);
    pushVarint(out, BigInt((spec.id << 3) | WIRE_BYTES));
    pushVarint(out, BigInt(body.length));
    for (const b of body) out.push(b);
    return;
  }
  const type = spec.type as ScalarType;
  if (type === 'string' || type === 'bytes') {
    let body: Uint8Array;
    if (type === 'string') {
      if (typeof value !== 'string') throw new Error(`Field "${name}" must be text.`);
      body = Buffer.from(value, 'utf8');
    } else {
      if (!(value instanceof Uint8Array)) throw new Error(`Field "${name}" must be bytes.`);
      body = value;
    }
    pushVarint(out, BigInt((spec.id << 3) | WIRE_BYTES));
    pushVarint(out, BigInt(body.length));
    for (const b of body) out.push(b);
    return;
  }
  pushVarint(out, BigInt((spec.id << 3) | WIRE_VARINT));
  pushVarint(out, scalarToVarint(type, value, name));
}

function encodeAt(schema: MessageSchema, message: Message, depth: number): Uint8Array {
  if (depth > MAX_DEPTH) throw new Error('Message is nested too deeply.');
  if (message === null || typeof message !== 'object') throw new Error('A message must be an object.');
  for (const key of Object.keys(message)) {
    // A misspelt field would otherwise vanish silently — and the device would
    // act on a message missing something the caller meant to send.
    if (message[key] !== undefined && !schema[key]) throw new Error(`Unknown field "${key}".`);
  }
  const out: number[] = [];
  const fields = Object.entries(schema).sort((a, b) => a[1].id - b[1].id);
  for (const [name, spec] of fields) {
    const value = message[name];
    if (value === undefined || value === null) continue;
    if (!spec.repeated) {
      encodeField(out, name, spec, value, depth);
      continue;
    }
    if (!Array.isArray(value)) throw new Error(`Field "${name}" must be a list.`);
    const scalar = typeof spec.type === 'string' && spec.type !== 'string' && spec.type !== 'bytes';
    if (spec.packed && scalar) {
      if (value.length === 0) continue;
      const run: number[] = [];
      for (const item of value) pushVarint(run, scalarToVarint(spec.type as ScalarType, item, name));
      pushVarint(out, BigInt((spec.id << 3) | WIRE_BYTES));
      pushVarint(out, BigInt(run.length));
      for (const b of run) out.push(b);
    } else {
      for (const item of value) encodeField(out, name, spec, item, depth);
    }
  }
  return Uint8Array.from(out);
}

/** Serialises `message`. Fields left undefined are not sent; unknown field names throw. */
export function encodeMessage(schema: MessageSchema, message: Message): Buffer {
  return Buffer.from(encodeAt(schema, message, 0));
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function varintToScalar(type: ScalarType, raw: bigint, name: string): any {
  switch (type) {
    case 'bool':
      return raw !== 0n;
    case 'uint32':
      return Number(BigInt.asUintN(32, raw));
    case 'uint64':
      return toNumber(raw, name);
    case 'int32':
    case 'enum':
      return Number(BigInt.asIntN(32, raw));
    case 'int64':
      return toNumber(BigInt.asIntN(64, raw), name);
    case 'sint32':
    case 'sint64':
      return toNumber((raw >> 1n) ^ -(raw & 1n), name);
    default:
      throw new Error(`Field "${name}" arrived as a number but is declared as ${type}.`);
  }
}

function decodeAt(schema: MessageSchema, bytes: Uint8Array, depth: number): Message {
  if (depth > MAX_DEPTH) throw new Error('Message is nested too deeply.');
  const byId = new Map<number, [string, FieldSpec]>();
  const out: Message = {};
  for (const [name, spec] of Object.entries(schema)) {
    byId.set(spec.id, [name, spec]);
    if (spec.repeated) out[name] = [];
  }

  let at = 0;
  while (at < bytes.length) {
    const key = readVarint(bytes, at);
    at = key.next;
    const id = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    const known = byId.get(id);

    let raw: bigint | null = null;
    let body: Uint8Array | null = null;
    if (wire === WIRE_VARINT) {
      const v = readVarint(bytes, at);
      raw = v.value;
      at = v.next;
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(bytes, at);
      at = len.next;
      const size = toNumber(len.value, 'length');
      if (at + size > bytes.length) throw new Error('Truncated message.');
      body = bytes.subarray(at, at + size);
      at += size;
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      // No message here declares a fixed-width field; step over one from a
      // newer firmware rather than fail on it.
      const size = wire === WIRE_FIXED64 ? 8 : 4;
      if (at + size > bytes.length) throw new Error('Truncated message.');
      at += size;
      continue;
    } else {
      throw new Error(`Malformed message (wire type ${wire}).`);
    }
    // Fields added by newer firmware are skipped, as protobuf intends.
    if (!known) continue;

    const [name, spec] = known;
    const nested = schemaOf(spec.type);
    let values: any[];
    if (nested) {
      if (!body) throw new Error(`Field "${name}" should be a message.`);
      values = [decodeAt(nested, body, depth + 1)];
    } else if (spec.type === 'string' || spec.type === 'bytes') {
      if (!body) throw new Error(`Field "${name}" should be length-delimited.`);
      // Copied, so the result does not pin (or alias) the packet buffer.
      values = [spec.type === 'string' ? Buffer.from(body).toString('utf8') : Buffer.from(Uint8Array.from(body))];
    } else if (body) {
      // A packed run of scalars.
      values = [];
      let p = 0;
      while (p < body.length) {
        const v = readVarint(body, p);
        values.push(varintToScalar(spec.type as ScalarType, v.value, name));
        p = v.next;
      }
    } else {
      values = [varintToScalar(spec.type as ScalarType, raw!, name)];
    }

    if (spec.repeated) out[name].push(...values);
    else if (values.length > 0) out[name] = values[values.length - 1]; // last one wins
  }
  return out;
}

/** Parses `bytes` against `schema`. Unknown fields are ignored. */
export function decodeMessage(schema: MessageSchema, bytes: Uint8Array): Message {
  return decodeAt(schema, bytes, 0);
}

import { Buffer } from 'buffer';

/**
 * Minimal CBOR codec covering the subset used by BC-UR registry types
 * (crypto-output / crypto-hdkey): unsigned ints, byte strings, text,
 * arrays, integer-keyed maps, booleans and tags.
 */
export class Tagged {
  constructor(
    public tag: number,
    public value: any
  ) {}
}

/** Additional-info value meaning "indefinite length, ends with a break". */
const INDEFINITE = 31;
const BREAK = 0xff;

export function decodeCbor(buf: Buffer): any {
  let offset = 0;

  function readLength(info: number): number {
    if (info < 24) return info;
    if (info === 24) return buf[offset++];
    if (info === 25) {
      const v = buf.readUInt16BE(offset);
      offset += 2;
      return v;
    }
    if (info === 26) {
      const v = buf.readUInt32BE(offset);
      offset += 4;
      return v;
    }
    if (info === 27) {
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      offset += 8;
      const v = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(v)) throw new Error('CBOR integer exceeds safe range.');
      return v;
    }
    throw new Error(`Malformed CBOR length (additional info ${info}).`);
  }

  function atBreak(): boolean {
    if (offset >= buf.length) throw new Error('Unexpected end of CBOR data.');
    if (buf[offset] === BREAK) {
      offset++;
      return true;
    }
    return false;
  }

  function readItem(): any {
    if (offset >= buf.length) throw new Error('Unexpected end of CBOR data.');
    const initial = buf[offset++];
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        // Indefinite-length byte string: a run of definite chunks.
        if (info === INDEFINITE) {
          const chunks: Buffer[] = [];
          while (!atBreak()) chunks.push(readItem());
          return Buffer.concat(chunks);
        }
        const len = readLength(info);
        if (offset + len > buf.length) throw new Error('Unexpected end of CBOR data.');
        const bytes = Buffer.from(buf.subarray(offset, offset + len));
        offset += len;
        return bytes;
      }
      case 3: {
        if (info === INDEFINITE) {
          let text = '';
          while (!atBreak()) text += readItem();
          return text;
        }
        const len = readLength(info);
        if (offset + len > buf.length) throw new Error('Unexpected end of CBOR data.');
        const text = buf.toString('utf8', offset, offset + len);
        offset += len;
        return text;
      }
      case 4: {
        const items: any[] = [];
        if (info === INDEFINITE) {
          while (!atBreak()) items.push(readItem());
          return items;
        }
        const len = readLength(info);
        for (let i = 0; i < len; i++) items.push(readItem());
        return items;
      }
      case 5: {
        // Cards (and other embedded encoders) commonly emit indefinite maps.
        const map = new Map();
        if (info === INDEFINITE) {
          while (!atBreak()) {
            const key = readItem();
            map.set(key, readItem());
          }
          return map;
        }
        const len = readLength(info);
        for (let i = 0; i < len; i++) {
          const key = readItem();
          map.set(key, readItem());
        }
        return map;
      }
      case 6:
        return new Tagged(readLength(info), readItem());
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === INDEFINITE) throw new Error('Unexpected CBOR break.');
        throw new Error(`Unsupported CBOR simple value ${info}.`);
      default:
        throw new Error(`Unsupported CBOR major type ${major}.`);
    }
  }

  return readItem();
}

export function encodeCbor(value: any): Buffer {
  const parts: Buffer[] = [];

  function head(major: number, length: number): void {
    if (length < 24) parts.push(Buffer.from([(major << 5) | length]));
    else if (length < 0x100) parts.push(Buffer.from([(major << 5) | 24, length]));
    else if (length < 0x10000) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(length, 1);
      parts.push(b);
    } else {
      const b = Buffer.alloc(5);
      b[0] = (major << 5) | 26;
      b.writeUInt32BE(length, 1);
      parts.push(b);
    }
  }

  function writeItem(v: any): void {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) head(0, v);
    else if (Buffer.isBuffer(v)) {
      head(2, v.length);
      parts.push(v);
    } else if (typeof v === 'string') {
      const b = Buffer.from(v, 'utf8');
      head(3, b.length);
      parts.push(b);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(writeItem);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [key, val] of v) {
        writeItem(key);
        writeItem(val);
      }
    } else if (v instanceof Tagged) {
      head(6, v.tag);
      writeItem(v.value);
    } else if (typeof v === 'boolean') {
      parts.push(Buffer.from([v ? 0xf5 : 0xf4]));
    } else {
      throw new Error(`Cannot CBOR-encode value: ${v}`);
    }
  }

  writeItem(value);
  return Buffer.concat(parts);
}

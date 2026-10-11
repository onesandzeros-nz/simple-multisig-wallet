import { Buffer } from 'buffer';
import { PacketTransport } from '../types';

/**
 * Trezor's original wire format ("codec v1"): a message is its numeric type,
 * its length and its protobuf body, cut into packets that each begin with
 * `?`. The first packet carries `##` and the header as well.
 *
 *   first packet:  '?' '#' '#'  type:u16be  length:u32be  body…
 *   later packets: '?'  body…
 *
 * Reference: trezor-firmware docs/common/protocol_v1, python trezorlib
 * transport/protocol.py.
 */

const MAGIC = 0x3f; // '?'
const HEADER_MARK = 0x23; // '#'
/** '?##' + type + length */
const FIRST_HEADER_LEN = 9;

/**
 * Nothing a Trezor sends comes near this — Features is a few hundred bytes —
 * so a longer claim is a fault or an attempt to make the phone allocate.
 */
export const MAX_MESSAGE_BYTES = 128 * 1024;

/** Once a message has started arriving, the rest follows at once. */
const CONTINUATION_TIMEOUT_MS = 5_000;

/**
 * How many stray packets to step over while looking for the start of a
 * message. Strays are the tail of a reply nobody finished reading.
 */
const MAX_STRAY_PACKETS = 64;

export interface WireMessage {
  type: number;
  data: Buffer;
}

/** Cuts one message into packets, each exactly `packetSize` long. */
export function encodePackets(type: number, data: Uint8Array, packetSize = 64): Buffer[] {
  if (!Number.isInteger(type) || type < 0 || type > 0xffff) throw new Error('Message type out of range.');
  if (data.length > MAX_MESSAGE_BYTES) throw new Error('That message is too large to send to a Trezor.');
  if (packetSize < FIRST_HEADER_LEN + 1) throw new Error('Packets are too small to carry a Trezor message.');

  const header = Buffer.alloc(8);
  header[0] = HEADER_MARK;
  header[1] = HEADER_MARK;
  header.writeUInt16BE(type, 2);
  header.writeUInt32BE(data.length, 4);
  const stream = Buffer.concat([header, Buffer.from(data)]);

  const perPacket = packetSize - 1;
  const packets: Buffer[] = [];
  for (let at = 0; at < stream.length; at += perPacket) {
    // alloc() zero-fills, which is the padding the last packet needs.
    const packet = Buffer.alloc(packetSize);
    packet[0] = MAGIC;
    stream.copy(packet, 1, at, Math.min(at + perPacket, stream.length));
    packets.push(packet);
  }
  return packets;
}

export async function writeMessage(transport: PacketTransport, type: number, data: Uint8Array): Promise<void> {
  for (const packet of encodePackets(type, data, transport.packetSize)) {
    await transport.write(packet);
  }
}

/**
 * Reads one whole message. `timeoutMs` is how long to wait for it to begin —
 * which can be as long as a person takes to read a screen and press a button.
 */
export async function readMessage(transport: PacketTransport, timeoutMs: number): Promise<WireMessage> {
  let first: Buffer | null = null;
  for (let strays = 0; !first; strays++) {
    if (strays > MAX_STRAY_PACKETS) throw new Error('The Trezor is sending data this app cannot make sense of.');
    // Hermes hands back a plain Uint8Array from subarray(); wrap before using Buffer methods.
    const packet = Buffer.from(await transport.read(timeoutMs));
    if (packet.length < FIRST_HEADER_LEN) continue;
    if (packet[0] === MAGIC && packet[1] === HEADER_MARK && packet[2] === HEADER_MARK) first = packet;
  }

  const type = first.readUInt16BE(3);
  const length = first.readUInt32BE(5);
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error('The Trezor announced a message far larger than any it should send.');
  }

  const chunks: Buffer[] = [Buffer.from(first.subarray(FIRST_HEADER_LEN))];
  let have = chunks[0].length;
  while (have < length) {
    const packet = Buffer.from(await transport.read(CONTINUATION_TIMEOUT_MS));
    if (packet.length < 2 || packet[0] !== MAGIC) {
      throw new Error('The Trezor sent a broken message. Unplug it, plug it back in and try again.');
    }
    const chunk = Buffer.from(packet.subarray(1));
    chunks.push(chunk);
    have += chunk.length;
  }
  return { type, data: Buffer.from(Buffer.concat(chunks).subarray(0, length)) };
}

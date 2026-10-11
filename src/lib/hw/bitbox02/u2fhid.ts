import { Buffer } from 'buffer';
import { PacketTransport } from '../types';

/**
 * U2F-HID message framing, which the BitBox02 borrows for its own channel.
 * Reference: FIDO U2F HID protocol, "Message and packet structure".
 *
 * A message is one initialisation packet followed by as many continuation
 * packets as it needs:
 *
 *   init:  channel id (4) | command (1) | length (2, big endian) | data (57)
 *   cont:  channel id (4) | sequence (1, counting from 0)        | data (59)
 *
 * The BitBox02 skips U2F's channel negotiation: both sides use one fixed
 * channel id, and the command byte says which of its two stacks — the wallet
 * firmware or the bootloader — the message is for.
 */

export const CHANNEL_ID = 0xff000000;
/** Vendor command 1 (with the initialisation-packet bit): the wallet firmware. */
export const HWW_CMD = 0x80 + 0x40 + 0x01;
/** Vendor command 3: the bootloader, which is all that answers while firmware is being installed. */
export const BOOTLOADER_CMD = 0x80 + 0x40 + 0x03;
const ERROR_CMD = 0x80 + 0x3f;

const INIT_HEADER = 7;
const CONT_HEADER = 5;
/** The protocol allows 128 continuation packets and no more. */
const MAX_CONTINUATIONS = 128;

/** The device rejected a frame outright, before anything looked at its contents. */
export class FrameError extends Error {
  constructor(
    message: string,
    /** U2F-HID error code; 0x01 is "no such command". */
    readonly code: number
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

export const FRAME_ERROR_INVALID_CMD = 0x01;

export function maxMessageLength(packetSize: number): number {
  return packetSize - INIT_HEADER + MAX_CONTINUATIONS * (packetSize - CONT_HEADER);
}

/** Splits one message into the packets that carry it. */
export function encodeFrame(cmd: number, message: Uint8Array, packetSize = 64): Buffer[] {
  if (message.length === 0) throw new Error('Cannot send an empty message.');
  if (message.length > maxMessageLength(packetSize)) {
    throw new Error('That message is too large to send to the BitBox02.');
  }
  const packets: Buffer[] = [];
  // Unused space is filled with 0xEE, as the official libraries do. The device
  // goes by the length in the header, so the value is only a convention.
  const first = Buffer.alloc(packetSize, 0xee);
  first.writeUInt32BE(CHANNEL_ID, 0);
  first[4] = cmd;
  first.writeUInt16BE(message.length, 5);
  let sent = Math.min(message.length, packetSize - INIT_HEADER);
  first.set(message.subarray(0, sent), INIT_HEADER);
  packets.push(first);

  for (let seq = 0; sent < message.length; seq++) {
    const packet = Buffer.alloc(packetSize, 0xee);
    packet.writeUInt32BE(CHANNEL_ID, 0);
    packet[4] = seq;
    const take = Math.min(message.length - sent, packetSize - CONT_HEADER);
    packet.set(message.subarray(sent, sent + take), CONT_HEADER);
    sent += take;
    packets.push(packet);
  }
  return packets;
}

export async function writeFrame(transport: PacketTransport, cmd: number, message: Uint8Array): Promise<void> {
  for (const packet of encodeFrame(cmd, message, transport.packetSize)) {
    await transport.write(packet);
  }
}

/**
 * Reads one whole message. Every packet is checked against the channel, the
 * command and the sequence it should carry, so a packet from some other
 * conversation is an error rather than bytes spliced into this one.
 */
export async function readFrame(transport: PacketTransport, cmd: number, timeoutMs: number): Promise<Buffer> {
  // Buffer.from: on Hermes a transport may hand back a plain Uint8Array.
  const first = Buffer.from(await transport.read(timeoutMs));
  if (first.length < INIT_HEADER) throw new Error('The BitBox02 sent a packet too short to read.');
  if (first.readUInt32BE(0) !== CHANNEL_ID) {
    throw new Error('The BitBox02 answered on an unexpected channel.');
  }
  const length = first.readUInt16BE(5);
  if (first[4] === ERROR_CMD) {
    const code = length > 0 ? first[INIT_HEADER] : 0;
    throw new FrameError(`The BitBox02 refused the message (framing error ${code}).`, code);
  }
  if (first[4] !== cmd) {
    throw new Error(`The BitBox02 answered a different command (0x${first[4].toString(16)}).`);
  }

  const parts: Buffer[] = [Buffer.from(first.subarray(INIT_HEADER))];
  let received = first.length - INIT_HEADER;
  for (let seq = 0; received < length; seq++) {
    if (seq >= MAX_CONTINUATIONS) throw new Error('The BitBox02 sent a message longer than the protocol allows.');
    const packet = Buffer.from(await transport.read(timeoutMs));
    if (packet.length <= CONT_HEADER) throw new Error('The BitBox02 sent a packet too short to read.');
    if (packet.readUInt32BE(0) !== CHANNEL_ID) {
      throw new Error('The BitBox02 answered on an unexpected channel.');
    }
    if (packet[4] !== seq) {
      throw new Error('The BitBox02 sent its answer out of order — unplug it, plug it back in and try again.');
    }
    parts.push(Buffer.from(packet.subarray(CONT_HEADER)));
    received += packet.length - CONT_HEADER;
  }
  return Buffer.from(Buffer.concat(parts).subarray(0, length));
}

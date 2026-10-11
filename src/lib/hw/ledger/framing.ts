import { Buffer } from 'buffer';
import { PacketTransport, TransportTimeout, UserCancelled } from '../types';

/**
 * Ledger's wire format: commands are smartcard-style APDUs, cut into 64-byte
 * USB packets. Every packet starts with a channel id, a tag and a sequence
 * number; the first also carries the length of the whole APDU.
 *
 * Reference: github.com/LedgerHQ/ledger-live libs/ledgerjs/packages/devices
 * src/hid-framing.ts, and HWI's ledgercomm/interfaces/hid_device.py
 */

const CHANNEL = 0x0101;
const TAG_APDU = 0x05;
const HEADER_BYTES = 5;

/** One byte of length is all a short APDU has. */
export const MAX_APDU_DATA = 255;

export const SW_OK = 0x9000;
/** Not an error: the app has a question for us before it can carry on. */
export const SW_INTERRUPTED_EXECUTION = 0xe000;
export const SW_DENY = 0x6985;
export const SW_SECURITY_STATUS_NOT_SATISFIED = 0x6982;
export const SW_INCORRECT_DATA = 0x6a80;
export const SW_NOT_SUPPORTED = 0x6a82;
export const SW_WRONG_P1P2 = 0x6a86;
export const SW_WRONG_DATA_LENGTH = 0x6a87;
export const SW_INS_NOT_SUPPORTED = 0x6d00;
export const SW_CLA_NOT_SUPPORTED = 0x6e00;
export const SW_BAD_STATE = 0xb007;
export const SW_SIGNATURE_FAIL = 0xb008;
/** Sent by the operating system rather than the app. */
export const SW_DEVICE_LOCKED = 0x5515;

export function buildApdu(cla: number, ins: number, p1: number, p2: number, data: Uint8Array = new Uint8Array(0)): Buffer {
  if (data.length > MAX_APDU_DATA) throw new Error('Command too large for a single APDU.');
  return Buffer.concat([Buffer.from([cla, ins, p1, p2, data.length]), data]);
}

/** Cuts an APDU into packets, the last padded with zeros. */
export function frameApdu(apdu: Uint8Array, packetSize = 64): Buffer[] {
  if (apdu.length > 0xffff) throw new Error('Command too large to send.');
  const room = packetSize - HEADER_BYTES;
  const payload = Buffer.concat([Buffer.from([apdu.length >> 8, apdu.length & 0xff]), apdu]);
  const packets: Buffer[] = [];
  for (let seq = 0; seq * room < payload.length; seq++) {
    const packet = Buffer.alloc(packetSize);
    packet.writeUInt16BE(CHANNEL, 0);
    packet[2] = TAG_APDU;
    packet.writeUInt16BE(seq, 3);
    Buffer.from(payload.subarray(seq * room, (seq + 1) * room)).copy(packet, HEADER_BYTES);
    packets.push(packet);
  }
  return packets;
}

/** Puts a reply back together, one packet at a time. */
export class ResponseAssembler {
  private expected = -1;
  private sequence = 0;
  private chunks: Buffer[] = [];
  private received = 0;

  /** The whole reply once `packet` completes it, otherwise null. */
  push(packet: Uint8Array): Buffer | null {
    const buf = Buffer.from(packet);
    if (buf.length < HEADER_BYTES + 2) throw new Error('The Ledger sent a packet too short to read.');
    if (buf.readUInt16BE(0) !== CHANNEL || buf[2] !== TAG_APDU) {
      throw new Error('The Ledger sent something that is not a reply to a command.');
    }
    if (buf.readUInt16BE(3) !== this.sequence) {
      throw new Error('The Ledger’s reply arrived out of order.');
    }
    let body = Buffer.from(buf.subarray(HEADER_BYTES));
    if (this.sequence === 0) {
      this.expected = body.readUInt16BE(0);
      // Nothing is shorter than a status word.
      if (this.expected < 2) throw new Error('The Ledger sent an empty reply.');
      body = Buffer.from(body.subarray(2));
    }
    this.sequence++;
    const wanted = this.expected - this.received;
    const chunk = Buffer.from(body.subarray(0, wanted));
    this.chunks.push(chunk);
    this.received += chunk.length;
    return this.received >= this.expected ? Buffer.concat(this.chunks) : null;
  }
}

export interface ApduResponse {
  data: Buffer;
  /** Status word: the last two bytes of every reply. */
  sw: number;
}

/** How long to wait for the rest of a reply once its first packet has arrived. */
const CONTINUATION_TIMEOUT_MS = 5_000;
/** How long a stale packet is given to turn up when clearing the line. */
const DRAIN_TIMEOUT_MS = 50;

/**
 * Sends APDUs and collects their replies, one exchange at a time.
 *
 * If an exchange dies halfway — a timeout, a garbled packet — its reply may
 * still be on its way. The line is cleared before the next command so that a
 * late answer is never mistaken for the answer to a different question.
 */
export class ApduChannel {
  private busy: Promise<unknown> = Promise.resolve();
  private stale = false;

  constructor(private readonly transport: PacketTransport) {}

  /**
   * `timeoutMs` is how long the Ledger gets to start answering. It needs to
   * be generous for anything the user confirms on the device.
   */
  exchange(apdu: Uint8Array, timeoutMs: number): Promise<ApduResponse> {
    const run = this.busy.then(() => this.exchangeNow(apdu, timeoutMs));
    // The queue moves on whether or not this exchange worked.
    this.busy = run.catch(() => {});
    return run;
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < 64; i++) {
      try {
        await this.transport.read(DRAIN_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof TransportTimeout) break;
        throw e;
      }
    }
    this.stale = false;
  }

  private async exchangeNow(apdu: Uint8Array, timeoutMs: number): Promise<ApduResponse> {
    if (this.stale) await this.drain();
    try {
      for (const packet of frameApdu(apdu, this.transport.packetSize)) {
        await this.transport.write(packet);
      }
      const assembler = new ResponseAssembler();
      let reply = assembler.push(await this.transport.read(timeoutMs));
      while (!reply) reply = assembler.push(await this.transport.read(CONTINUATION_TIMEOUT_MS));
      return {
        data: Buffer.from(reply.subarray(0, reply.length - 2)),
        sw: reply.readUInt16BE(reply.length - 2),
      };
    } catch (e) {
      this.stale = true;
      if (e instanceof TransportTimeout) {
        throw new TransportTimeout(
          'The Ledger did not answer in time. Check it is unlocked with the Bitcoin app open, then try again.'
        );
      }
      throw e;
    }
  }
}

/** A reply whose status word says no. */
export class LedgerStatusError extends Error {
  constructor(
    message: string,
    readonly sw: number,
    /** Newer apps say more about some refusals in two bytes ahead of the status word. */
    readonly detail?: number
  ) {
    super(message);
    this.name = 'LedgerStatusError';
  }
}

const hex4 = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

/** Friendly text for the status words in doc/bitcoin.md. `doing` reads after "while". */
export function describeStatus(sw: number, doing: string): string {
  switch (sw) {
    case SW_DEVICE_LOCKED:
      return 'The Ledger is locked. Unlock it with its PIN, then try again.';
    case SW_SECURITY_STATUS_NOT_SATISFIED:
      return 'The Ledger refused for security reasons — check it is unlocked, then try again.';
    case SW_CLA_NOT_SUPPORTED:
    case SW_INS_NOT_SUPPORTED:
      return 'The Bitcoin app is not open on the Ledger. Open it, then try again.';
    case SW_INCORRECT_DATA:
    case SW_WRONG_P1P2:
    case SW_WRONG_DATA_LENGTH:
      return `The Ledger could not accept what it was sent while ${doing} (${hex4(sw)}).`;
    case SW_NOT_SUPPORTED:
      return `The Bitcoin app on this Ledger does not support ${doing}. Updating the app in Ledger Live may help.`;
    case SW_BAD_STATE:
      return `The Ledger gave up while ${doing}. Close and reopen the Bitcoin app, then try again.`;
    case SW_SIGNATURE_FAIL:
      return 'The Ledger does not recognise its approval of this wallet.';
    case 0x6faa:
      return 'The Ledger has frozen. Unplug it, plug it back in, and try again.';
    default:
      return `The Ledger reported an error while ${doing} (${hex4(sw)}).`;
  }
}

/** Throws unless the status word is one of `accept`. A refusal on the device is a cancellation, not a failure. */
export function checkStatus(response: ApduResponse, doing: string, accept: number[] = [SW_OK]): void {
  if (accept.includes(response.sw)) return;
  if (response.sw === SW_DENY) throw new UserCancelled('Rejected on the Ledger.');
  const detail = response.data.length === 2 ? response.data.readUInt16BE(0) : undefined;
  console.warn(
    `[ledger] ${doing}: sw=${hex4(response.sw)}` + (detail === undefined ? '' : ` detail=${hex4(detail)}`)
  );
  throw new LedgerStatusError(describeStatus(response.sw, doing), response.sw, detail);
}

import { Buffer } from 'buffer';
import { parseIncomingPsbt } from './wallet';
import { NetworkName } from './types';

/**
 * Pulls a PSBT out of whatever a hardware wallet wrote to an NFC tag.
 *
 * Cards differ: some write the raw transaction as a binary record, some write
 * base64 or hex in a text record, and some put a header in front of it. Every
 * candidate is parsed before being returned, so a wrong guess fails here with
 * a clear reason rather than surfacing later as "not a valid transaction".
 */
const PSBT_MAGIC = Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]);

/** NDEF text records begin with a status byte and a language code. */
export function decodeNdefText(payload: Buffer): string {
  if (payload.length === 0) return '';
  const languageLength = payload[0] & 0x3f;
  // Range arguments, never subarray().toString(): on Hermes subarray() loses
  // Buffer-ness and the encoding argument is silently ignored.
  return payload.toString('utf8', 1 + languageLength);
}

function candidatesFrom(payload: Buffer): string[] {
  const out: string[] = [];

  // Binary: the transaction itself, possibly behind a header.
  const magicAt = payload.indexOf(PSBT_MAGIC);
  if (magicAt !== -1) out.push(payload.toString('base64', magicAt));

  // Text: base64 or hex, with or without the NDEF language header.
  for (const text of [decodeNdefText(payload), payload.toString('utf8')]) {
    const cleaned = text.replace(/\s+/g, '').replace(/\0+$/, '');
    if (!cleaned) continue;
    if (/^cHNidP/.test(cleaned)) out.push(cleaned);
    if (/^70736274ff/i.test(cleaned) && cleaned.length % 2 === 0) {
      out.push(Buffer.from(cleaned, 'hex').toString('base64'));
    }
  }
  return out;
}

/** Short description of a record, for an error a person can act on. */
function describe(payload: Buffer): string {
  const head = payload.toString('hex', 0, 8);
  return `${payload.length} bytes starting ${head || '(empty)'}`;
}

export function extractPsbt(payloads: Buffer[], network: NetworkName): string {
  if (payloads.length === 0) {
    throw new Error('Nothing to read — export the signed transaction on the card first.');
  }
  // Why each attempt failed, so a rejection is explained rather than guessed at.
  const reasons: string[] = [];

  for (const [i, payload] of payloads.entries()) {
    const candidates = candidatesFrom(payload);
    if (candidates.length === 0) {
      reasons.push(`#${i}: no transaction in it (${describe(payload)})`);
      continue;
    }
    for (const candidate of candidates) {
      try {
        parseIncomingPsbt(candidate, network); // only return something that really parses
        return candidate;
      } catch (e: any) {
        reasons.push(`#${i}: ${e?.message ?? e}`);
      }
    }
  }
  console.error(`[nfc:psbt] nothing usable — ${reasons.join(' | ')}`);
  throw new Error(`Could not read the transaction from that tag. ${reasons[0] ?? ''}`.trim());
}

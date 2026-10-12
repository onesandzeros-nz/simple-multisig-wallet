import { URDecoder } from '@ngraveio/bc-ur';
import { Buffer } from 'buffer';
import {
  cryptoAccountToText,
  cryptoHdkeyToKeyExpression,
  cryptoOutputToText,
} from './cryptoOutput';
import { decodeCbor } from './cbor';

/**
 * Assembles wallet data from one or many QR codes. Supports:
 *  - a single plain-text QR (descriptor / config file / JSON)
 *  - Specter-style numbered parts:  "p2of5 <chunk>"
 *  - BC-UR animated QRs (ur:bytes / ur:crypto-output framing), the format
 *    used by Sparrow, Keystone, SeedSigner, Passport & friends
 */
export interface QrProgress {
  done: boolean;
  /** Assembled text, present when done. */
  text?: string;
  /** Human-readable progress, e.g. "Part 2 of 5" or "38%". */
  progress?: string;
}

/**
 * Progress as parts collected, not the library's estimate. The estimate
 * counts every frame seen, repeats included, and tops out at 99%; devices
 * such as Jade loop a fixed set of frames, so a scan that keeps missing one
 * frame would show "99%" indefinitely while nothing was happening.
 */
function urProgress(decoder: URDecoder): string {
  const expected = decoder.expectedPartCount();
  if (expected === 0) return `${Math.round(decoder.estimatedPercentComplete() * 100)}%`;
  return `${decoder.receivedPartIndexes().length} of ${expected} parts`;
}

export function createQrAssembler() {
  let mode: 'unknown' | 'ur' | 'parts' = 'unknown';
  let urDecoder: URDecoder | null = null;
  const parts = new Map<number, string>();
  let totalParts = 0;

  function receive(raw: string): QrProgress {
    const data = raw.trim();
    if (!data) return { done: false };

    // BC-UR frames: ur:<type>/<seq>/<payload> (case-insensitive)
    if (/^ur:/i.test(data)) {
      if (mode === 'unknown') {
        mode = 'ur';
        urDecoder = new URDecoder();
      }
      if (mode !== 'ur' || !urDecoder) {
        throw new Error('This QR code belongs to a different transfer — start again.');
      }
      const frame = data.toLowerCase();
      let accepted: boolean;
      try {
        accepted = urDecoder.receivePart(frame);
      } catch (e) {
        // A frame the camera misread. Mid-transfer it is noise — the next
        // pass of the animation brings the frame round again — so keep what
        // has been collected. With nothing collected yet, say what is wrong.
        if (urDecoder.expectedPartCount() === 0) throw e;
        return { done: false, progress: urProgress(urDecoder) };
      }
      if (!accepted) {
        // A well-formed frame the decoder turned away: it belongs to another
        // transfer (a different transaction, or the same one re-encoded). A
        // device only ever shows one animation, so follow it instead of
        // waiting forever for frames of the old one.
        const fresh = new URDecoder();
        if (!fresh.receivePart(frame)) return { done: false, progress: urProgress(urDecoder) };
        urDecoder = fresh;
      }
      if (urDecoder.isError()) {
        // Every part arrived but the message failed its checksum: a frame
        // was misread as another valid frame. The decoder never reports
        // itself complete in this state, so without this check the scan sat
        // at "99%" forever. It cannot recover; the caller restarts clean.
        throw new Error('The animated QR did not read cleanly — hold the camera steady on it; starting again.');
      }
      if (!urDecoder.isComplete()) {
        return { done: false, progress: urProgress(urDecoder) };
      }
      if (!urDecoder.isSuccess()) {
        throw new Error(`Could not read the animated QR: ${urDecoder.resultError()}`);
      }
      const ur = urDecoder.resultUR();
      if (ur.type === 'bytes') {
        return { done: true, text: Buffer.from(ur.decodeCBOR()).toString('utf8') };
      }
      if (ur.type === 'crypto-output') {
        // Sparrow/Keystone descriptor QRs: a whole wallet, or one account key.
        return { done: true, text: cryptoOutputToText(Buffer.from(ur.cbor)) };
      }
      if (ur.type === 'crypto-hdkey') {
        // Jade and others export a single account key this way.
        return { done: true, text: cryptoHdkeyToKeyExpression(Buffer.from(ur.cbor)) };
      }
      if (ur.type === 'crypto-account') {
        return { done: true, text: cryptoAccountToText(Buffer.from(ur.cbor)) };
      }
      if (ur.type === 'crypto-psbt') {
        // BCR-2020-006: a CBOR byte string holding the raw PSBT.
        const decoded = decodeCbor(Buffer.from(ur.cbor));
        if (!Buffer.isBuffer(decoded)) throw new Error('That QR does not contain a transaction.');
        return { done: true, text: decoded.toString('base64') };
      }
      throw new Error(
        `This QR encodes "${ur.type}" data, which isn't supported. In the exporting app choose a descriptor, wallet config or file export instead.`
      );
    }

    // Specter-style numbered parts: "p1of3 <chunk>" (chunks carry no
    // meaningful edge whitespace in the wild — concatenated verbatim).
    const numbered = data.match(/^p(\d+)of(\d+) ([\s\S]*)$/i);
    if (numbered) {
      if (mode === 'unknown') {
        mode = 'parts';
        totalParts = parseInt(numbered[2], 10);
      }
      if (mode !== 'parts') {
        throw new Error('This QR code belongs to a different transfer — start again.');
      }
      const index = parseInt(numbered[1], 10);
      const total = parseInt(numbered[2], 10);
      if (total !== totalParts || index < 1 || index > total) {
        throw new Error('This QR code belongs to a different transfer — start again.');
      }
      parts.set(index, numbered[3]);
      if (parts.size < totalParts) {
        return { done: false, progress: `Part ${parts.size} of ${totalParts}` };
      }
      const text = Array.from({ length: totalParts }, (_, i) => parts.get(i + 1)!).join('');
      return { done: true, text };
    }

    // A single self-contained QR.
    if (mode !== 'unknown') {
      // Mid-transfer we may catch a stray frame; ignore it.
      return { done: false, progress: mode === 'parts' ? `Part ${parts.size} of ${totalParts}` : undefined };
    }
    return { done: true, text: data };
  }

  return { receive };
}

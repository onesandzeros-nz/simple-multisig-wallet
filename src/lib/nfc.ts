import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import { CardSignature, SignRequest, tapsignerFetchKey, tapsignerSign, TapsignerKey } from './tapsigner';
import { describeNfcError } from './nfcErrors';
import { extractPsbt } from './psbtFromBytes';
import { NetworkName } from './types';

// Loaded lazily and defensively: the native module only exists in dev builds
// that include react-native-nfc-manager (not in Expo Go).
let NfcManager: any = null;
let NfcTech: any = null;
let Ndef: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-nfc-manager');
  NfcManager = mod.default;
  NfcTech = mod.NfcTech;
  Ndef = mod.Ndef;
} catch {
  // NFC not available in this build
}

/** A TAPSIGNER can spend seconds on a single sign command. */
const CARD_TIMEOUT_MS = 10000;

function nfcFailure(e: any): Error {
  // A tap that is cancelled, times out or loses contact is an expected,
  // recoverable outcome — not a crash. Log it at warn level (so it does not
  // surface as a red error box) and let the caller show the friendly text.
  console.warn(`[nfc] ${e?.constructor?.name ?? typeof e}: ${e?.message ?? e}`);
  return new Error(describeNfcError(e));
}

export async function nfcAvailable(): Promise<boolean> {
  try {
    return !!NfcManager && (await NfcManager.isSupported());
  } catch {
    return false;
  }
}

/**
 * Reads an NDEF tag (Coldcard Mk4/Q present their NFC exports this way)
 * and returns every text payload found on it, in record order.
 */
export async function readNdefTexts(): Promise<string[]> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  await NfcManager.start();
  try {
    // Clear any session a previous tap left open, otherwise this request can
    // fail immediately with "one request at a time" on the second attempt.
    await NfcManager.cancelTechnologyRequest().catch(() => {});
    // Android can support NFC while it is switched off — say so plainly rather
    // than failing with a vague, instant error.
    const enabled = await NfcManager.isEnabled().catch(() => true);
    if (!enabled) {
      throw new Error('NFC is switched off. Turn it on in your phone settings, then try again.');
    }
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef, {
        alertMessage: 'Hold the phone against the Coldcard.',
      });
    } catch (e) {
      throw nfcFailure(e);
    }
    const tag = await NfcManager.getTag();
    const records: any[] = tag?.ndefMessage ?? [];
    if (records.length === 0) throw new Error('Nothing to read — start the export on the Coldcard first.');

    const texts: string[] = [];
    for (const record of records) {
      const payload = Uint8Array.from(record.payload ?? []);
      if (payload.length === 0) continue;
      const type = String.fromCharCode(...(record.type ?? []));
      try {
        if (record.tnf === 1 && type === 'T') {
          // Well-known text record: strip the language header properly.
          texts.push(Ndef.text.decodePayload(payload));
          continue;
        }
      } catch {
        // fall through to raw decoding
      }
      const raw = Buffer.from(payload).toString('utf8');
      if (raw.trim()) texts.push(raw);
    }
    if (texts.length === 0) throw new Error('The tag had no readable text on it.');
    return texts;
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

/**
 * Writes a PSBT to a Coldcard's NFC tag. Coldcard recognises the payload by
 * its `psbt\xff` magic, so it goes out as a binary NDEF record.
 */
export async function writePsbtToTag(base64: string): Promise<void> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  const bytes = Array.from(Buffer.from(base64.trim(), 'base64'));
  await NfcManager.start();
  try {
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef, {
        alertMessage: 'Hold the phone against the Coldcard.',
      });
    } catch (e) {
      throw nfcFailure(e);
    }
    const record = Ndef.record(Ndef.TNF_MIME_MEDIA, 'application/octet-stream', [], bytes);
    const message = Ndef.encodeMessage([record]);
    if (!message) throw new Error('Could not build the NFC message.');
    try {
      await NfcManager.ndefHandler.writeNdefMessage(message);
    } catch (e) {
      throw nfcFailure(e);
    }
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

/**
 * Writes plain text to a Coldcard's NFC tag — how it takes a multisig wallet
 * config, which is the same text file it accepts from an SD card.
 */
export async function writeTextToTag(text: string, prompt: string): Promise<void> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  await NfcManager.start();
  try {
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef, { alertMessage: prompt });
    } catch (e) {
      throw nfcFailure(e);
    }
    const message = Ndef.encodeMessage([Ndef.textRecord(text)]);
    if (!message) throw new Error('Could not build the NFC message.');
    try {
      await NfcManager.ndefHandler.writeNdefMessage(message);
    } catch (e) {
      throw nfcFailure(e);
    }
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

/** Every record on the tag as raw bytes, whatever its type. */
async function readNdefPayloads(prompt: string): Promise<Buffer[]> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  await NfcManager.start();
  try {
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef, { alertMessage: prompt });
    } catch (e) {
      throw nfcFailure(e);
    }
    const tag = await NfcManager.getTag();
    const records: any[] = tag?.ndefMessage ?? [];
    for (const r of records) {
      const type = Buffer.from(Uint8Array.from(r.type ?? [])).toString('utf8');
      console.log(`[nfc:record] tnf=${r.tnf} type="${type}" length=${(r.payload ?? []).length}`);
    }
    return records.map((r) => Buffer.from(Uint8Array.from(r.payload ?? [])));
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

/**
 * Reads a signed transaction back off a card. What each card writes varies,
 * so every record is logged and every plausible encoding is tried and
 * validated before one is accepted.
 */
export async function readPsbtFromTag(network: NetworkName): Promise<string> {
  const payloads = await readNdefPayloads('Hold the phone against the card.');
  console.log(
    `[nfc:read] ${payloads.length} record(s): ` +
      payloads
        .map((p, i) => `#${i} len=${p.length} head=${p.toString('hex', 0, 12)}`)
        .join(' | ')
  );
  return extractPsbt(payloads, network);
}

/**
 * Ends whatever NFC session is open, so a waiting tap can be called off. The
 * pending request rejects, which its own caller reports as a cancellation.
 */
export async function cancelNfcSession(): Promise<void> {
  if (!NfcManager) return;
  await NfcManager.cancelTechnologyRequest().catch(() => {});
}

/**
 * Opens an IsoDep session for a smartcard and returns its transceive function.
 *
 * The timeout matters: Android defaults IsoDep to a few hundred milliseconds,
 * but a TAPSIGNER takes longer than that to produce a signature, so the tag
 * appears to drop out mid-command. Setting it must follow requestTechnology,
 * which is what binds the tag the timeout applies to.
 */
async function openCardSession(): Promise<(apdu: Uint8Array) => Promise<Uint8Array>> {
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, {
      alertMessage: 'Hold the TAPSIGNER against the back of the phone.',
    });
  } catch (e) {
    throw nfcFailure(e);
  }
  if (Platform.OS === 'android') {
    await NfcManager.setTimeout(CARD_TIMEOUT_MS).catch(() => {});
  }
  return async (apdu: Uint8Array): Promise<Uint8Array> => {
    try {
      return Uint8Array.from(await NfcManager.isoDepHandler.transceive(Array.from(apdu)));
    } catch (e) {
      throw nfcFailure(e);
    }
  };
}

/** Signs a set of digests with a TAPSIGNER in one tap. */
export async function signWithTapsigner(
  cvc: string,
  requests: SignRequest[],
  path: string,
  expectFingerprint?: string
): Promise<CardSignature[]> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  await NfcManager.start();
  try {
    const transceive = await openCardSession();
    const signatures = await tapsignerSign(transceive, cvc, requests, path, expectFingerprint);
    if (Platform.OS === 'ios') await NfcManager.setAlertMessageIOS('Signed.');
    return signatures;
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

/**
 * Runs the whole TAPSIGNER import inside one NFC session.
 * Resolves with the key, or rejects with a friendly error.
 */
export async function importFromTapsigner(cvc: string): Promise<TapsignerKey> {
  if (!NfcManager) {
    throw new Error('NFC needs a development build that includes react-native-nfc-manager.');
  }
  await NfcManager.start();
  try {
    const transceive = await openCardSession();
    const key = await tapsignerFetchKey(transceive, cvc);
    if (Platform.OS === 'ios') {
      await NfcManager.setAlertMessageIOS('Key imported.');
    }
    return key;
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

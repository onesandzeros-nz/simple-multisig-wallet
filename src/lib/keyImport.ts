import { isFingerprint, normaliseXpub, parseKeyExpression, ParsedKeyExpression } from './slip132';
import { KeySource } from './types';

export interface ParsedKeyImport extends ParsedKeyExpression {
  name?: string;
  /** Set when the key came from a device that can also sign — a card, or a wallet on USB. */
  source?: KeySource;
}

/**
 * A fingerprint from a file is kept only when it is one. Anything else is
 * dropped, and the key is saved with the fingerprint derived from its xpub,
 * as a key that came without one is — never with the file's text, which
 * every other member's parser would refuse silently and a Ledger would
 * choke on.
 */
function validFingerprint(value: unknown): string | undefined {
  return isFingerprint(value) ? value.toLowerCase() : undefined;
}

function fromColdcardSection(obj: any, section: any): ParsedKeyImport {
  const key = section._pub ?? section.xpub;
  if (typeof key !== 'string') throw new Error('No xpub found in this file.');
  const parsed = normaliseXpub(key);
  // Top-level xfp is the MASTER fingerprint (the section's xfp is the
  // derived node's own fingerprint — not what key origins need).
  const fp = validFingerprint(obj.xfp ?? section.xfp);
  const path = typeof section.deriv === 'string' ? section.deriv.replace(/h/g, "'") : undefined;
  return { ...parsed, fingerprint: fp, path };
}

/**
 * Parses key material pasted, scanned or loaded from a file:
 *  - descriptor key expressions / bare xpubs (any SLIP-132 flavour)
 *  - Coldcard "generic JSON" wallet export (uses the bip48_2 / P2WSH section)
 *  - Coldcard "export XPUB" multisig JSON ({ xfp, p2wsh_deriv, p2wsh })
 *  - simple JSON: { xpub, xfp | fingerprint, deriv | derivation | path }
 */
export function parseKeyImportText(input: string): ParsedKeyImport {
  const text = input.trim();
  if (!text) throw new Error('Nothing to import.');

  if (text.startsWith('{')) {
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('This is not valid JSON.');
    }
    if (typeof obj !== 'object' || obj === null) throw new Error('This is not a key file.');

    // Coldcard generic wallet export: pick the P2WSH multisig section.
    if (obj.bip48_2 && typeof obj.bip48_2 === 'object') {
      return fromColdcardSection(obj, obj.bip48_2);
    }
    // Coldcard multisig xpub export.
    if (typeof obj.p2wsh === 'string') {
      return fromColdcardSection(obj, { xpub: obj.p2wsh, deriv: obj.p2wsh_deriv, xfp: obj.xfp });
    }
    // Simple {xpub, fingerprint, path} shapes.
    if (typeof obj.xpub === 'string') {
      const parsed = normaliseXpub(obj.xpub);
      const fp = validFingerprint(obj.xfp ?? obj.fingerprint ?? obj.root_fingerprint);
      const rawPath = obj.deriv ?? obj.derivation ?? obj.path;
      const path = typeof rawPath === 'string' ? rawPath.replace(/h/g, "'") : undefined;
      return { ...parsed, fingerprint: fp, path, name: typeof obj.label === 'string' ? obj.label : undefined };
    }
    throw new Error('Unrecognised key JSON — expected a Coldcard export or an object with an "xpub" field.');
  }

  return parseKeyExpression(text);
}

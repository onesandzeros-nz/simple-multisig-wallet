/**
 * Payment target scanned from a QR code: either a bare address or a
 * BIP21 URI (bitcoin:ADDRESS?amount=0.001&label=...).
 */
export interface PaymentTarget {
  address: string;
  /** Amount in sats, if the URI carried one. */
  amountSats?: number;
  label?: string;
  message?: string;
}

export function parsePaymentTarget(input: string): PaymentTarget {
  const text = input.trim();
  if (!text) throw new Error('Nothing scanned.');

  const uri = text.match(/^bitcoin:([^?]*)(?:\?(.*))?$/i);
  if (!uri) {
    // Bare address (QR codes often use uppercase bech32).
    if (/\s/.test(text)) throw new Error('That QR code is not a bitcoin address.');
    return { address: /^(BC1|TB1|BCRT1)/.test(text) ? text.toLowerCase() : text };
  }

  const address = uri[1].trim();
  if (!address) throw new Error('That payment link has no address in it.');
  const target: PaymentTarget = {
    address: /^(BC1|TB1|BCRT1)/.test(address) ? address.toLowerCase() : address,
  };

  for (const part of (uri[2] ?? '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (key === 'amount') {
      // BIP21 amounts are in BTC.
      const btc = parseFloat(value);
      if (!Number.isFinite(btc) || btc < 0) throw new Error(`Could not read the amount "${value}".`);
      target.amountSats = Math.round(btc * 1e8);
    } else if (key === 'label') {
      target.label = value;
    } else if (key === 'message') {
      target.message = value;
    } else if (key.startsWith('req-')) {
      // BIP21 says unknown req- parameters must not be ignored.
      throw new Error(`This payment link needs "${key}", which this wallet does not support.`);
    }
  }
  return target;
}

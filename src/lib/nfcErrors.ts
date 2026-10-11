/**
 * The NFC library throws typed errors with EMPTY messages (e.g.
 * `new TagConnectionLost()`), which surface to the user as a blank alert.
 * Translate them into something actionable. Kept free of React Native
 * imports so it can be unit tested in Node.
 */
const BY_NAME: Record<string, string> = {
  UserCancel: 'Scan cancelled.',
  Timeout: 'The card was not detected in time — try again and hold it still against the phone.',
  TagConnectionLost:
    'Lost contact with the card. Hold it flat against the back of the phone and keep it there until the import finishes.',
  TagNotConnected: 'The card was not connected — hold it against the phone and try again.',
  RetryExceeded: 'The card kept dropping out. Try a different spot on the back of the phone.',
  TagResponseError: 'The card responded with an error — move it slightly and try again.',
  SessionInvalidated: 'The NFC session ended before the import finished. Try again.',
  RadioDisabled: 'NFC is switched off — enable it in your phone settings and try again.',
  SystemBusy: 'The phone’s NFC system is busy — wait a moment and try again.',
  UnsupportedFeature: 'This phone cannot talk to this kind of card.',
  PacketTooLong: 'The card rejected an over-long command (this is a bug — please report it).',
};

export function describeNfcError(e: any): string {
  const name = e?.constructor?.name ?? '';
  const raw = typeof e === 'string' ? e : (e?.message ?? '');
  if (BY_NAME[name]) return BY_NAME[name];
  if (/cancel/i.test(raw)) return 'Scan cancelled.';
  if (/tag was lost|connection lost/i.test(raw)) return BY_NAME.TagConnectionLost;
  if (/nfc.*(disabled|off)/i.test(raw)) return BY_NAME.RadioDisabled;
  if (raw) return raw;
  return name && name !== 'Object' ? `NFC error: ${name}` : 'NFC failed for an unknown reason. Try again.';
}

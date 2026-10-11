/**
 * Expo wraps what a native call throws in its own account of which function
 * failed ("Call to function 'UsbHost.open' has been rejected. → Caused by: …").
 * The part written for a person is the cause at the end. Kept free of React
 * Native imports so it can be unit tested in Node.
 */
export function describeUsbError(e: any): Error {
  const raw = String(e?.message ?? e ?? '').trim();
  const cause = raw.split(/Caused by:\s*/).pop()!.trim();
  return new Error(cause || raw || 'The USB connection failed for an unknown reason.');
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeRelays } from '../src/lib/nostr/probe';
import { makeFakeRelay } from './fakeRelay';

describe('relay probe', () => {
  it('passes a relay that stores a group event and serves it back', async () => {
    const relay = makeFakeRelay({ retain: true });
    const [result] = await probeRelays(['wss://good'], relay.factory, 500);
    assert.deepEqual(result, { url: 'wss://good', ok: true });
  });

  it('fails a relay that refuses, with its reason', async () => {
    const relay = makeFakeRelay({ retain: true, reject: () => 'blocked: kind not allowed' });
    const [result] = await probeRelays(['wss://strict'], relay.factory, 500);
    assert.deepEqual(result, { url: 'wss://strict', ok: false, reason: 'blocked: kind not allowed' });
  });

  it('fails a relay that accepts but never serves the event back, and one that never answers', async () => {
    const forgetful = makeFakeRelay({ retain: false });
    const silent = makeFakeRelay({ retain: false, ack: false });
    const [a, b] = await Promise.all([
      probeRelays(['wss://forgetful'], forgetful.factory, 100),
      probeRelays(['wss://silent'], silent.factory, 100),
    ]);
    assert.deepEqual(a[0], { url: 'wss://forgetful', ok: false, reason: 'accepted it but did not serve it back' });
    assert.deepEqual(b[0], { url: 'wss://silent', ok: false, reason: 'no answer' });
  });
});

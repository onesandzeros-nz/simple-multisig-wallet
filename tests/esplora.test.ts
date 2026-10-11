import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeBroadcastError,
  esploraServer,
  esploraWebBase,
  fetchAddressStats,
  fetchFees,
  fetchTxHex,
  fetchUtxos,
  feesFromEstimates,
  retryDelayMs,
  setEsploraServer,
  setRetrySleep,
} from '../src/lib/esplora';
import { fetchTxHex as chainTxHex, setBackend, txExplorerUrl } from '../src/lib/chain';

describe('esplora server override', () => {
  after(() => setBackend({ kind: 'esplora', url: null }));

  it('defaults to blockstream.info', () => {
    setEsploraServer(null);
    assert.equal(esploraServer(), 'https://blockstream.info');
    assert.equal(esploraWebBase('mainnet'), 'https://blockstream.info');
    assert.equal(esploraWebBase('testnet'), 'https://blockstream.info/testnet');
  });

  it('uses a custom server and strips trailing slashes', () => {
    setBackend({ kind: 'esplora', url: 'https://mempool.example.org///' });
    assert.equal(esploraServer(), 'https://mempool.example.org');
    assert.equal(esploraWebBase('testnet'), 'https://mempool.example.org/testnet');
    // Explorer links follow the custom server too (and only carry a real txid).
    const txid = 'c'.repeat(64);
    assert.equal(txExplorerUrl('mainnet', txid), `https://mempool.example.org/tx/${txid}`);
    assert.equal(txExplorerUrl('mainnet', 'abc123'), 'https://mempool.example.org');
  });

  it('clears back to the default', () => {
    setEsploraServer('https://x.example');
    setEsploraServer(null);
    assert.equal(esploraServer(), 'https://blockstream.info');
  });
});

describe('broadcast rejections', () => {
  it('explains a fee that is below the relay minimum', () => {
    const msg = describeBroadcastError(400, 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 100 < 141"}');
    assert.match(msg, /fee is too low/i);
    assert.match(msg, /min relay fee not met/, 'keeps the raw reason');
  });

  it('recognises an already-sent transaction as success-ish', () => {
    assert.match(describeBroadcastError(400, 'txn-already-in-mempool'), /already in the mempool/i);
    assert.match(describeBroadcastError(400, 'txn-already-known'), /already in the mempool/i);
    assert.match(describeBroadcastError(400, 'Transaction already in block chain'), /already confirmed/i);
  });

  it('explains spent inputs and bad signatures', () => {
    assert.match(describeBroadcastError(400, 'bad-txns-inputs-missingorspent'), /already been spent/i);
    assert.match(
      describeBroadcastError(400, 'non-mandatory-script-verify-flag (Signature must be zero for failed CHECK(MULTI)SIG operation)'),
      /rejected the signatures/i
    );
  });

  it('flags a wrong server address and server faults', () => {
    assert.match(describeBroadcastError(404, 'Not Found'), /no broadcast endpoint/i);
    assert.match(describeBroadcastError(502, 'Bad Gateway'), /server had a problem/i);
  });

  it('explains a bare Electrum-mode rejection', () => {
    // What mempool.space in electrum backend mode returns: a code, no message.
    const msg = describeBroadcastError(400, '{"error":"sendrawtransaction RPC error: {\\"code\\":-1}"}');
    assert.match(msg, /without giving a reason/i);
    assert.match(msg, /electrum layer/i);
  });

  it('falls back to the raw reason', () => {
    assert.match(describeBroadcastError(400, 'some novel node complaint'), /some novel node complaint/);
    assert.match(describeBroadcastError(400, ''), /no reason given/);
  });
});

describe('rate limiting', () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
    setRetrySleep(null);
  });

  function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }

  it('reads Retry-After as seconds, as a date, or backs off exponentially', () => {
    assert.equal(retryDelayMs('2', 0), 2000);
    assert.equal(retryDelayMs('600', 0), 15000, 'caps a long Retry-After');
    const inFive = new Date(Date.now() + 5000).toUTCString();
    const fromDate = retryDelayMs(inFive, 0);
    assert.ok(fromDate > 3000 && fromDate <= 5000, `date form: ${fromDate}`);
    assert.equal(retryDelayMs(null, 0), 1000);
    assert.equal(retryDelayMs(null, 2), 4000);
    assert.equal(retryDelayMs('garbage', 3), 8000, 'ignores an unreadable header');
  });

  it('retries a 429 after the server-suggested delay and then succeeds', async () => {
    const slept: number[] = [];
    setRetrySleep(async (ms) => {
      slept.push(ms);
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3
        ? respond(429, 'slow down', { 'retry-after': '3' })
        : respond(200, JSON.stringify([{ txid: 'a', vout: 0, value: 1, status: { confirmed: true } }]));
    }) as typeof fetch;

    const utxos = await fetchUtxos('mainnet', 'bc1qexample');
    assert.equal(utxos.length, 1);
    assert.equal(calls, 3);
    assert.deepEqual(slept, [3000, 3000]);
  });

  it('gives up on a persistent 429 with advice to change server', async () => {
    setRetrySleep(async () => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return respond(429, 'slow down');
    }) as typeof fetch;

    await assert.rejects(fetchAddressStats('mainnet', 'bc1qexample'), /rate limiting.*Settings/s);
    assert.equal(calls, 4, 'bounded number of attempts');
  });

  it('does not retry an ordinary failure', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return respond(500, 'boom');
    }) as typeof fetch;
    await assert.rejects(fetchAddressStats('mainnet', 'bc1qexample'), /Network error \(500\)/);
    assert.equal(calls, 1);
  });

  it('caps how many requests are in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return respond(200, '[]');
    }) as typeof fetch;

    await Promise.all(Array.from({ length: 12 }, (_, i) => fetchUtxos('mainnet', `bc1q${i}`)));
    assert.equal(peak, 3);
  });

  it('frees its slot when a request fails', async () => {
    globalThis.fetch = (async () => respond(500, 'boom')) as typeof fetch;
    await Promise.allSettled(Array.from({ length: 6 }, () => fetchUtxos('mainnet', 'x')));
    globalThis.fetch = (async () => respond(200, '[]')) as typeof fetch;
    // If a slot leaked above, this would hang rather than resolve.
    await Promise.all(Array.from({ length: 6 }, () => fetchUtxos('mainnet', 'x')));
  });
});

describe('raw transactions', () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
    setBackend({ kind: 'esplora', url: null });
  });
  const txid = 'ab'.repeat(32);

  it('asks for the hex of a transaction, on the right network', async () => {
    setBackend({ kind: 'esplora', url: 'https://node.example' });
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response('0200AbCd\n', { status: 200 });
    }) as typeof fetch;
    assert.equal(await fetchTxHex('mainnet', txid.toUpperCase()), '0200abcd');
    assert.equal(await chainTxHex('testnet', txid), '0200abcd');
    assert.deepEqual(asked, [
      `https://node.example/api/tx/${txid}/hex`,
      `https://node.example/testnet/api/tx/${txid}/hex`,
    ]);
  });

  it('never puts anything but a txid in the URL', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('00', { status: 200 });
    }) as typeof fetch;
    await assert.rejects(fetchTxHex('mainnet', '../../address/x'), /not a transaction id/);
    await assert.rejects(fetchTxHex('mainnet', 'abc'), /not a transaction id/);
    assert.equal(calls, 0);
  });

  it('refuses a reply that is not hex', async () => {
    globalThis.fetch = (async () => new Response('<html>Not found</html>', { status: 200 })) as typeof fetch;
    await assert.rejects(fetchTxHex('mainnet', txid), /malformed/);
    globalThis.fetch = (async () => new Response('abc', { status: 200 })) as typeof fetch;
    await assert.rejects(fetchTxHex('mainnet', txid), /malformed/);
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    await assert.rejects(fetchTxHex('mainnet', txid), /Network error \(404\)/);
  });
});

describe('fee estimates', () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
    setEsploraServer(null);
  });

  it('maps Esplora confirmation targets onto the mempool.space tiers', () => {
    const fees = feesFromEstimates({ '1': 12.4, '2': 11, '3': 8.2, '6': 5, '25': 3, '144': 1.6, '1008': 0.3 });
    assert.deepEqual(fees, { fastestFee: 13, halfHourFee: 9, hourFee: 5, economyFee: 2, minimumFee: 1 });
  });

  it('never goes below 1 sat/vB and copes with sparse or bad tables', () => {
    // A quiet chain: blockstream.info really does report 0.3 sat/vB.
    const quiet = feesFromEstimates({ '1': 0.8, '3': 0.8, '6': 0.377, '144': 0.292, '504': 0.1, '1008': 0.1 });
    assert.deepEqual(quiet, { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 });
    // Only a couple of targets: later tiers take the slowest rate offered.
    assert.deepEqual(feesFromEstimates({ '2': 20, '10': 4 }), {
      fastestFee: 20, halfHourFee: 4, hourFee: 4, economyFee: 4, minimumFee: 4,
    });
    assert.deepEqual(feesFromEstimates({}), { fastestFee: 10, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 });
    assert.deepEqual(feesFromEstimates({ x: NaN, '3': -1 } as any).fastestFee, 10);
  });

  it('falls back to /fee-estimates on a server without the mempool endpoint, and remembers', async () => {
    setEsploraServer('https://esplora-only.example');
    const hits: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      hits.push(url);
      if (url.endsWith('/v1/fees/recommended')) return new Response('Not found', { status: 404 });
      if (url.endsWith('/fee-estimates')) return new Response(JSON.stringify({ '1': 7, '6': 3 }), { status: 200 });
      return new Response('?', { status: 500 });
    }) as typeof fetch;

    const first = await fetchFees('mainnet');
    assert.equal(first.fastestFee, 7);
    assert.equal(first.hourFee, 3);
    assert.deepEqual(hits.map((h) => h.split('/api')[1]), ['/v1/fees/recommended', '/fee-estimates']);

    hits.length = 0;
    await fetchFees('mainnet');
    assert.deepEqual(hits.map((h) => h.split('/api')[1]), ['/fee-estimates'], 'skips the endpoint it knows is missing');
  });

  it('prefers the mempool endpoint where it exists', async () => {
    setEsploraServer('https://mempool-style.example');
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.endsWith('/v1/fees/recommended')) {
        return new Response(JSON.stringify({ fastestFee: 9, halfHourFee: 6, hourFee: 4, economyFee: 2, minimumFee: 1 }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    assert.equal((await fetchFees('mainnet')).fastestFee, 9);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import {
  addressToScripthash,
  btcPerKbToSatPerVb,
  encodeRequest,
  errorMessage,
  feedLines,
  headerTimestamp,
  isConfirmedHeight,
} from '../src/lib/electrum/protocol';
import { ElectrumClient, ElectrumSocket } from '../src/lib/electrum/client';
import { ElectrumAdapter } from '../src/lib/electrum/adapter';
import { deriveAddress } from '../src/lib/bitcoin';
import { MNEMONICS, makeWallet, DEST_MAINNET } from './helpers';

describe('electrum protocol', () => {
  it('frames requests as one JSON line each', () => {
    const line = encodeRequest({ id: 7, method: 'server.version', params: ['a', '1.4'] });
    assert.ok(line.endsWith('\n'));
    const parsed = JSON.parse(line);
    assert.equal(parsed.id, 7);
    assert.equal(parsed.method, 'server.version');
  });

  it('reassembles responses split across chunks', () => {
    // A TCP read can land anywhere, including mid-object.
    const first = feedLines('', '{"id":1,"result":"a"}\n{"id":2,"res');
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].result, 'a');
    const second = feedLines(first.rest, 'ult":"b"}\n');
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].result, 'b');
    assert.equal(second.rest, '');
  });

  it('skips blank and malformed lines without losing the rest', () => {
    const { messages } = feedLines('', '\n{bad json}\n{"id":3,"result":1}\n');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].result, 1);
  });

  it('reads errors in both shapes servers use', () => {
    assert.match(errorMessage({ code: 2, message: 'bad-txns-inputs-missingorspent' }), /missingorspent/);
    assert.match(errorMessage({ code: 2, message: 'x' }), /code 2/);
    assert.equal(errorMessage('plain string error'), 'plain string error');
  });

  it('derives the script hash Electrum indexes by', () => {
    // BIP173 test vector address; sha256 of its scriptPubKey, reversed.
    const script = bitcoin.address.toOutputScript(DEST_MAINNET, bitcoin.networks.bitcoin);
    const expected = Buffer.from(bitcoin.crypto.sha256(script)).reverse().toString('hex');
    assert.equal(addressToScripthash(DEST_MAINNET, 'mainnet'), expected);
    assert.equal(addressToScripthash(DEST_MAINNET, 'mainnet').length, 64);
  });

  it('converts fee rates and recognises mempool heights', () => {
    assert.equal(btcPerKbToSatPerVb(0.00001), 1); // 1000 sat/kvB = 1 sat/vB
    assert.equal(btcPerKbToSatPerVb(0.0001), 10);
    assert.equal(btcPerKbToSatPerVb(-1), null); // server says "no estimate"
    assert.equal(isConfirmedHeight(800_000), true);
    assert.equal(isConfirmedHeight(0), false); // in the mempool
    assert.equal(isConfirmedHeight(-1), false); // unconfirmed parent
  });

  it('reads the timestamp out of a block header', () => {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(1_700_000_000, 68);
    assert.equal(headerTimestamp(header.toString('hex')), 1_700_000_000);
    assert.throws(() => headerTimestamp('00'), /Short block header/);
  });
});

/** An in-memory Electrum server driven by a handler map. */
function fakeServer(handlers: Record<string, (params: any[]) => any>) {
  const sent: any[] = [];
  const factory = (): ElectrumSocket => {
    const listeners: Record<string, Function[]> = {};
    const emit = (event: string, arg?: any) => (listeners[event] ?? []).forEach((f) => f(arg));
    const socket: ElectrumSocket = {
      write: (data: string) => {
        for (const line of data.split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          sent.push(req);
          const handler = handlers[req.method];
          let reply: any;
          if (!handler) {
            reply = { id: req.id, error: { code: 1, message: `unknown method ${req.method}` } };
          } else {
            try {
              reply = { id: req.id, result: handler(req.params) };
            } catch (e: any) {
              reply = { id: req.id, error: { code: 2, message: e.message } };
            }
          }
          // Answer asynchronously, as a socket would.
          setTimeout(() => emit('data', `${JSON.stringify(reply)}\n`), 0);
        }
      },
      destroy: () => emit('close'),
      on: (event: string, cb: any) => {
        (listeners[event] ??= []).push(cb);
        if (event === 'connect') setTimeout(() => cb(), 0);
      },
    } as ElectrumSocket;
    return socket;
  };
  return { factory, sent };
}

const wallet = makeWallet(2, MNEMONICS.slice(0, 2));
const walletAddress = deriveAddress(wallet, 0, 0).address;

/** A confirmed transaction paying `value` to `address`. */
function payTo(address: string, value: number): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 9), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin), value);
  return tx;
}

describe('electrum client', () => {
  it('negotiates the version and resolves calls by id', async () => {
    const { factory, sent } = fakeServer({
      'server.version': () => ['electrs/0.11.1', '1.4'],
      'blockchain.headers.subscribe': () => ({ height: 961_340 }),
    });
    const client = new ElectrumClient({ host: 'h', port: 50001 }, factory);
    const tip = await client.call('blockchain.headers.subscribe');
    assert.equal(tip.height, 961_340);
    assert.equal(sent[0].method, 'server.version', 'must handshake before anything else');
    client.close();
  });

  it('surfaces a server error as a readable message', async () => {
    const { factory } = fakeServer({ 'server.version': () => ['electrs', '1.4'] });
    const client = new ElectrumClient({ host: 'h', port: 50001 }, factory);
    await assert.rejects(() => client.call('blockchain.nonsense'), /unknown method/);
    client.close();
  });

  it('keeps concurrent calls apart', async () => {
    const { factory } = fakeServer({
      'server.version': () => ['electrs', '1.4'],
      'blockchain.estimatefee': (p) => (p[0] === 1 ? 0.0001 : 0.00001),
    });
    const client = new ElectrumClient({ host: 'h', port: 50001 }, factory);
    const [fast, slow] = await Promise.all([
      client.call('blockchain.estimatefee', [1]),
      client.call('blockchain.estimatefee', [6]),
    ]);
    assert.equal(fast, 0.0001);
    assert.equal(slow, 0.00001);
    client.close();
  });
});

describe('electrum adapter', () => {
  const funding = payTo(walletAddress, 50_000);
  const fundingId = funding.getId();

  function adapterFor(extra: Record<string, (p: any[]) => any> = {}) {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(1_700_000_500, 68);
    const { factory } = fakeServer({
      'server.version': () => ['electrs/0.11.1', '1.4'],
      'blockchain.scripthash.get_history': () => [{ tx_hash: fundingId, height: 800_000 }],
      'blockchain.scripthash.listunspent': () => [
        { tx_hash: fundingId, tx_pos: 0, height: 800_000, value: 50_000 },
      ],
      'blockchain.transaction.get': () => funding.toHex(),
      'blockchain.block.header': () => header.toString('hex'),
      ...extra,
    });
    const client = new ElectrumClient({ host: 'h', port: 50001 }, factory);
    return { adapter: new ElectrumAdapter(client, 'mainnet'), client };
  }

  it('reports address stats the scanner understands', async () => {
    const { adapter, client } = adapterFor();
    const stats = await adapter.addressStats(walletAddress);
    assert.equal(stats.chain_stats.tx_count, 1);
    assert.equal(stats.mempool_stats.tx_count, 0);
    client.close();
  });

  it('separates mempool from confirmed history', async () => {
    const { adapter, client } = adapterFor({
      'blockchain.scripthash.get_history': () => [
        { tx_hash: fundingId, height: 800_000 },
        { tx_hash: fundingId, height: 0 },
      ],
    });
    const stats = await adapter.addressStats(walletAddress);
    assert.equal(stats.chain_stats.tx_count, 1);
    assert.equal(stats.mempool_stats.tx_count, 1);
    client.close();
  });

  it('maps unspent outputs into the Esplora shape', async () => {
    const { adapter, client } = adapterFor();
    const utxos = await adapter.utxos(walletAddress);
    assert.equal(utxos.length, 1);
    assert.deepEqual(utxos[0], {
      txid: fundingId,
      vout: 0,
      value: 50_000,
      status: { confirmed: true, block_height: 800_000 },
    });
    client.close();
  });

  it('rebuilds transactions with outputs, prevouts and a block time', async () => {
    const { adapter, client } = adapterFor();
    const txs = await adapter.addressTxs(walletAddress);
    assert.equal(txs.length, 1);
    const tx = txs[0];
    assert.equal(tx.txid, fundingId);
    assert.equal(tx.status.confirmed, true);
    assert.equal(tx.status.block_time, 1_700_000_500, 'timestamp comes from the block header');
    assert.equal(tx.vout[0].scriptpubkey_address, walletAddress);
    assert.equal(tx.vout[0].value, 50_000);
    client.close();
  });

  it('caches raw transactions instead of asking twice', async () => {
    let fetches = 0;
    const { adapter, client } = adapterFor({
      'blockchain.transaction.get': () => {
        fetches++;
        return funding.toHex();
      },
    });
    await adapter.addressTxs(walletAddress);
    const afterFirst = fetches;
    await adapter.addressTxs(walletAddress);
    assert.equal(fetches, afterFirst, 'the second pass must reuse the cache');
    client.close();
  });

  it('serves a raw transaction for a hardware wallet to check', async () => {
    const asked: string[] = [];
    const { adapter, client } = adapterFor({
      'blockchain.transaction.get': (params) => {
        asked.push(params[0]);
        return funding.toHex();
      },
    });
    assert.equal(await adapter.txHex(fundingId.toUpperCase()), funding.toHex());
    assert.deepEqual(asked, [fundingId]);
    await assert.rejects(adapter.txHex('not a txid'), /not a transaction id/);
    client.close();
  });

  it('turns fee estimates into sat/vB', async () => {
    const { adapter, client } = adapterFor({
      'blockchain.estimatefee': (p) => ({ 1: 0.0001, 3: 0.00005, 6: 0.00002 })[p[0] as number] ?? -1,
    });
    const fees = await adapter.fees();
    assert.equal(fees.fastestFee, 10);
    assert.equal(fees.halfHourFee, 5);
    assert.equal(fees.hourFee, 2);
    client.close();
  });

  it('falls back sensibly when the server has no fee estimate', async () => {
    const { adapter, client } = adapterFor({ 'blockchain.estimatefee': () => -1 });
    const fees = await adapter.fees();
    assert.ok(fees.fastestFee >= 1 && fees.halfHourFee >= 1 && fees.hourFee >= 1);
    client.close();
  });

  it('broadcasts and returns the txid', async () => {
    const { adapter, client } = adapterFor({
      'blockchain.transaction.broadcast': () => fundingId,
    });
    assert.equal(await adapter.broadcast(funding.toHex()), fundingId);
    client.close();
  });

  it('passes a node rejection through with its message intact', async () => {
    const { adapter, client } = adapterFor({
      'blockchain.transaction.broadcast': () => {
        // Exactly what electrs relays from bitcoind.
        throw new Error('bad-txns-inputs-missingorspent');
      },
    });
    await assert.rejects(() => adapter.broadcast(funding.toHex()), /bad-txns-inputs-missingorspent/);
    client.close();
  });

  it('rejects a success response that is not a txid', async () => {
    const { adapter, client } = adapterFor({
      'blockchain.transaction.broadcast': () => 'not-a-txid',
    });
    await assert.rejects(() => adapter.broadcast(funding.toHex()), /did not return|no txid/i);
    client.close();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAddress } from '../src/lib/bitcoin';
import { ChainApi, syncWallet, WalletSync } from '../src/lib/wallet';
import { EsploraAddressStats, EsploraTx, EsploraUtxo } from '../src/lib/esplora';
import { MultisigWallet } from '../src/lib/types';
import { MNEMONICS, makeWallet } from './helpers';

/** A fake chain whose per-address contents the test controls. */
function makeChain(wallet: MultisigWallet) {
  const utxosByAddress = new Map<string, EsploraUtxo[]>();
  const txsByAddress = new Map<string, EsploraTx[]>();
  const calls = { stats: 0, utxos: 0, txs: 0 };

  const addr = (branch: 0 | 1, index: number) => deriveAddress(wallet, branch, index).address;

  function fund(branch: 0 | 1, index: number, value: number, opts: { confirmed?: boolean; txid?: string } = {}) {
    const address = addr(branch, index);
    const txid = opts.txid ?? `${(utxosByAddress.size + 1).toString(16).padStart(2, '0')}`.repeat(32).slice(0, 64);
    const confirmed = opts.confirmed ?? true;
    utxosByAddress.set(address, [
      ...(utxosByAddress.get(address) ?? []),
      { txid, vout: 0, value, status: { confirmed, block_height: confirmed ? 800_000 : undefined } },
    ]);
    txsByAddress.set(address, [
      ...(txsByAddress.get(address) ?? []),
      {
        txid,
        fee: 200,
        status: { confirmed, block_height: confirmed ? 800_000 : undefined, block_time: confirmed ? 1_700_000_000 : undefined },
        vin: [],
        vout: [{ scriptpubkey_address: address, value }],
      },
    ]);
    return txid;
  }

  /** Spend everything at an address: tx count rises, UTXOs disappear. */
  function spend(branch: 0 | 1, index: number) {
    const address = addr(branch, index);
    const prior = utxosByAddress.get(address) ?? [];
    utxosByAddress.set(address, []);
    txsByAddress.set(address, [
      ...(txsByAddress.get(address) ?? []),
      {
        txid: 'ff'.repeat(32),
        fee: 300,
        status: { confirmed: true, block_height: 800_100, block_time: 1_700_000_500 },
        vin: prior.map((u) => ({ prevout: { scriptpubkey_address: address, value: u.value } })),
        vout: [],
      },
    ]);
  }

  /** Mark an address's unconfirmed entries as confirmed — tx count unchanged. */
  function confirmAll(branch: 0 | 1, index: number) {
    const address = addr(branch, index);
    utxosByAddress.set(
      address,
      (utxosByAddress.get(address) ?? []).map((u) => ({
        ...u,
        status: { confirmed: true, block_height: 800_200 },
      }))
    );
    txsByAddress.set(
      address,
      (txsByAddress.get(address) ?? []).map((t) => ({
        ...t,
        status: { confirmed: true, block_height: 800_200, block_time: 1_700_001_000 },
      }))
    );
  }

  const api: ChainApi = {
    async addressStats(_network, address): Promise<EsploraAddressStats> {
      calls.stats++;
      const txs = txsByAddress.get(address) ?? [];
      const confirmed = txs.filter((t) => t.status.confirmed).length;
      const mempool = txs.length - confirmed;
      return {
        address,
        chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: confirmed },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: mempool },
      };
    },
    async utxos(_network, address) {
      calls.utxos++;
      return utxosByAddress.get(address) ?? [];
    },
    async addressTxs(_network, address) {
      calls.txs++;
      return txsByAddress.get(address) ?? [];
    },
  };

  return { api, calls, fund, spend, confirmAll, addr };
}

const wallet = makeWallet(2, MNEMONICS.slice(0, 2));

describe('incremental wallet sync', () => {
  it('a first sync finds the coins and builds history', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 50_000);
    chain.fund(0, 1, 25_000);

    const sync = await syncWallet(wallet, undefined, chain.api);
    assert.equal(sync.snapshot.confirmedSats, 75_000);
    assert.equal(sync.snapshot.utxos.length, 2);
    assert.equal(sync.snapshot.nextReceiveIndex, 2);
    assert.equal(sync.history.length, 2);
    assert.equal(Object.keys(sync.addressTxCounts).length, 2);
  });

  it('a second sync with nothing new fetches no coins or history at all', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 50_000);
    const first = await syncWallet(wallet, undefined, chain.api);

    const before = { ...chain.calls };
    const second = await syncWallet(wallet, first, chain.api);

    assert.equal(chain.calls.utxos, before.utxos, 'refetched UTXOs despite no change');
    assert.equal(chain.calls.txs, before.txs, 'refetched history despite no change');
    assert.ok(chain.calls.stats > before.stats, 'stats are still checked');
    assert.equal(second.snapshot.confirmedSats, 50_000);
    assert.deepEqual(second.history, first.history);
  });

  it('only the changed address is re-fetched', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 50_000);
    chain.fund(0, 1, 25_000);
    const first = await syncWallet(wallet, undefined, chain.api);

    chain.spend(0, 0); // address 0 changes, address 1 does not
    const before = { ...chain.calls };
    const second = await syncWallet(wallet, first, chain.api);

    assert.equal(chain.calls.utxos - before.utxos, 1, 'should refetch exactly one address');
    assert.equal(second.snapshot.confirmedSats, 25_000, 'spent coin removed from the balance');
    assert.equal(second.snapshot.utxos.length, 1);
    assert.equal(second.history.length, 3, 'the spend joins the cached history');
  });

  it('re-checks an address that had unconfirmed money, even though its count is unchanged', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 40_000, { confirmed: false });
    const first = await syncWallet(wallet, undefined, chain.api);
    assert.equal(first.snapshot.unconfirmedSats, 40_000);
    assert.equal(first.snapshot.confirmedSats, 0);

    chain.confirmAll(0, 0); // a confirmation does not change tx_count
    const before = { ...chain.calls };
    const second = await syncWallet(wallet, first, chain.api);

    assert.ok(chain.calls.utxos > before.utxos, 'must recheck a previously unconfirmed address');
    assert.equal(second.snapshot.confirmedSats, 40_000);
    assert.equal(second.snapshot.unconfirmedSats, 0);
  });

  it('picks up a payment to a brand-new address beyond the last used one', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 10_000);
    const first = await syncWallet(wallet, undefined, chain.api);

    chain.fund(0, 3, 60_000); // inside the gap window
    const second = await syncWallet(wallet, first, chain.api);

    assert.equal(second.snapshot.confirmedSats, 70_000);
    assert.equal(second.snapshot.nextReceiveIndex, 4);
    assert.equal(second.snapshot.usedAddresses.length, 2);
  });

  it('tracks change addresses separately from receive addresses', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 10_000);
    chain.fund(1, 0, 5_000);
    const sync = await syncWallet(wallet, undefined, chain.api);
    assert.equal(sync.snapshot.confirmedSats, 15_000);
    assert.equal(sync.snapshot.nextReceiveIndex, 1);
    assert.equal(sync.snapshot.nextChangeIndex, 1);
  });

  it('a forced full sync from no cache matches an incremental one', async () => {
    const chain = makeChain(wallet);
    chain.fund(0, 0, 10_000);
    chain.fund(0, 2, 7_000);
    const incremental: WalletSync = await syncWallet(
      wallet,
      await syncWallet(wallet, undefined, chain.api),
      chain.api
    );
    const full = await syncWallet(wallet, undefined, chain.api);
    assert.equal(incremental.snapshot.confirmedSats, full.snapshot.confirmedSats);
    assert.deepEqual(
      incremental.snapshot.utxos.map((u) => u.txid).sort(),
      full.snapshot.utxos.map((u) => u.txid).sort()
    );
    assert.deepEqual(incremental.addressTxCounts, full.addressTxCounts);
  });
});

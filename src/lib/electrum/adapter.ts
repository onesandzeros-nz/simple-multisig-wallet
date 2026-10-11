import * as bitcoin from 'bitcoinjs-lib';
import { btcNetwork } from '../bitcoin';
import { clampFeeRate, EsploraAddressStats, EsploraTx, EsploraUtxo, RecommendedFees } from '../esplora';
import { NetworkName } from '../types';
import {
  addressToScripthash,
  btcPerKbToSatPerVb,
  headerTimestamp,
  isConfirmedHeight,
} from './protocol';

/**
 * Presents an Electrum server (electrs, Fulcrum, ElectrumX) through the same
 * shapes the Esplora client returns, so the wallet engine does not care which
 * backend it is talking to.
 *
 * Electrum gives less per call than Esplora: history is only txids and
 * heights, and transactions come back as raw hex with no previous outputs
 * resolved. Those gaps are filled here by fetching and decoding, with caches
 * so a rescan does not repeat the work.
 */
export interface ElectrumRpc {
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
}

interface HistoryEntry {
  tx_hash: string;
  height: number;
  fee?: number;
}

interface UnspentEntry {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

export class ElectrumAdapter {
  /** Raw transactions are immutable, so they cache indefinitely. */
  private txCache = new Map<string, bitcoin.Transaction>();
  /** Block timestamps by height — also immutable once mined. */
  private timeCache = new Map<number, number>();

  constructor(
    private rpc: ElectrumRpc,
    private network: NetworkName
  ) {}

  private scripthash(address: string): string {
    return addressToScripthash(address, this.network);
  }

  private async history(address: string): Promise<HistoryEntry[]> {
    return this.rpc.call<HistoryEntry[]>('blockchain.scripthash.get_history', [
      this.scripthash(address),
    ]);
  }

  private async rawTx(txid: string): Promise<bitcoin.Transaction> {
    const hit = this.txCache.get(txid);
    if (hit) return hit;
    const hex = await this.rpc.call<string>('blockchain.transaction.get', [txid]);
    const tx = bitcoin.Transaction.fromHex(hex);
    this.txCache.set(txid, tx);
    return tx;
  }

  /** A whole transaction as hex, for hardware wallets. The caller checks it hashes to `txid`. */
  async txHex(txid: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('That is not a transaction id.');
    return (await this.rawTx(txid.toLowerCase())).toHex();
  }

  private async blockTime(height: number): Promise<number | undefined> {
    if (!isConfirmedHeight(height)) return undefined;
    const hit = this.timeCache.get(height);
    if (hit) return hit;
    try {
      const header = await this.rpc.call<string>('blockchain.block.header', [height]);
      const time = headerTimestamp(header);
      this.timeCache.set(height, time);
      return time;
    } catch {
      // A missing header should not sink the whole history.
      return undefined;
    }
  }

  private addressOf(script: Buffer): string | undefined {
    try {
      return bitcoin.address.fromOutputScript(script, btcNetwork(this.network));
    } catch {
      return undefined; // OP_RETURN and other non-address outputs
    }
  }

  /** Esplora-shaped address summary, derived from the history list. */
  async addressStats(address: string): Promise<EsploraAddressStats> {
    const entries = await this.history(address);
    const confirmed = entries.filter((e) => isConfirmedHeight(e.height)).length;
    return {
      address,
      chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: confirmed },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: entries.length - confirmed },
    };
  }

  async utxos(address: string): Promise<EsploraUtxo[]> {
    const entries = await this.rpc.call<UnspentEntry[]>('blockchain.scripthash.listunspent', [
      this.scripthash(address),
    ]);
    return entries.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: u.value,
      status: {
        confirmed: isConfirmedHeight(u.height),
        block_height: isConfirmedHeight(u.height) ? u.height : undefined,
      },
    }));
  }

  /**
   * Rebuilds Esplora-style transactions: outputs come from the raw tx, and
   * each input's previous output is looked up so the wallet can work out what
   * it spent and what the fee was.
   */
  async addressTxs(address: string): Promise<EsploraTx[]> {
    const entries = await this.history(address);
    const out: EsploraTx[] = [];

    for (const entry of entries) {
      const tx = await this.rawTx(entry.tx_hash);

      const vout = tx.outs.map((o) => ({
        scriptpubkey_address: this.addressOf(Buffer.from(o.script)),
        value: o.value,
      }));

      const vin: EsploraTx['vin'] = [];
      let inputTotal = 0;
      let inputsKnown = true;
      for (const input of tx.ins) {
        const prevTxid = Buffer.from(input.hash).reverse().toString('hex');
        try {
          const prev = await this.rawTx(prevTxid);
          const prevOut = prev.outs[input.index];
          if (!prevOut) throw new Error('missing prevout');
          inputTotal += prevOut.value;
          vin.push({
            prevout: {
              scriptpubkey_address: this.addressOf(Buffer.from(prevOut.script)),
              value: prevOut.value,
            },
          });
        } catch {
          // Coinbase inputs, or a prevout the server will not serve.
          inputsKnown = false;
          vin.push({});
        }
      }

      const outputTotal = tx.outs.reduce((s, o) => s + o.value, 0);
      const confirmed = isConfirmedHeight(entry.height);
      out.push({
        txid: entry.tx_hash,
        // Prefer the server's own figure when it offers one (mempool entries).
        fee: entry.fee ?? (inputsKnown ? Math.max(0, inputTotal - outputTotal) : 0),
        status: {
          confirmed,
          block_height: confirmed ? entry.height : undefined,
          block_time: await this.blockTime(entry.height),
        },
        vin,
        vout,
      });
    }
    return out;
  }

  async broadcast(txHex: string): Promise<string> {
    const txid = await this.rpc.call<string>('blockchain.transaction.broadcast', [txHex]);
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
      throw new Error(`The server accepted it but returned no txid: ${String(txid).slice(0, 200)}`);
    }
    return txid;
  }

  /** Electrum has no fee bands, so ask for three confirmation targets. */
  async fees(): Promise<RecommendedFees> {
    const [fast, medium, slow] = await Promise.all([
      this.rpc.call<number>('blockchain.estimatefee', [1]).catch(() => -1),
      this.rpc.call<number>('blockchain.estimatefee', [3]).catch(() => -1),
      this.rpc.call<number>('blockchain.estimatefee', [6]).catch(() => -1),
    ]);
    const rate = (value: number, fallback: number) => {
      const converted = btcPerKbToSatPerVb(value);
      // Clamp a hostile/implausible estimatefee so it cannot drive a
      // wallet-draining fee; floor at 1 sat/vB.
      return converted === null ? fallback : Math.max(1, clampFeeRate(converted, fallback));
    };
    const fastestFee = rate(fast, 10);
    const halfHourFee = rate(medium, Math.min(fastestFee, 5));
    const hourFee = rate(slow, Math.min(halfHourFee, 3));
    return {
      fastestFee,
      halfHourFee,
      hourFee,
      economyFee: hourFee,
      minimumFee: 1,
    };
  }

  async tipHeight(): Promise<number> {
    const tip = await this.rpc.call<{ height: number }>('blockchain.headers.subscribe', []);
    if (!tip || typeof tip.height !== 'number') throw new Error('Server did not return a block height.');
    return tip.height;
  }
}

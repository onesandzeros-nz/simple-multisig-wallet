import * as bitcoin from 'bitcoinjs-lib';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import {
  bip32,
  btcNetwork,
  deriveAddress,
  DerivedAddress,
  DUST_SATS,
  estimateVsize,
  multisigInputVbytes,
  rootFromMnemonic,
} from './bitcoin';
import {
  fetchAddressStats,
  fetchAddressTxs,
  fetchUtxos,
  EsploraAddressStats,
  EsploraTx,
  EsploraUtxo,
} from './esplora';
import { AddressInfo, HistoryItem, MultisigWallet, NetworkName, Utxo, WalletSnapshot } from './types';
import { MAX_PSBT_CHARS } from './nostr/protocol';

const GAP_LIMIT = 20;
const SCAN_BATCH = 5;
const MAX_ADDRESSES = 200;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** The chain calls sync needs — injectable so tests can drive a fake chain. */
export interface ChainApi {
  addressStats(network: NetworkName, address: string): Promise<EsploraAddressStats>;
  utxos(network: NetworkName, address: string): Promise<EsploraUtxo[]>;
  addressTxs(network: NetworkName, address: string): Promise<EsploraTx[]>;
}

const defaultChainApi: ChainApi = {
  addressStats: fetchAddressStats,
  utxos: fetchUtxos,
  addressTxs: fetchAddressTxs,
};

export interface WalletSync {
  snapshot: WalletSnapshot;
  history: HistoryItem[];
  /** Per address: the tx count seen at the last sync, used to detect change. */
  addressTxCounts: Record<string, number>;
}

interface ScannedAddress {
  info: AddressInfo;
  /** Combined chain + mempool tx count. */
  txCount: number;
  hasMempool: boolean;
}

/**
 * Walks a branch until the gap limit, returning every address that has ever
 * been used. Only cheap /address stats calls happen here — the expensive
 * per-address UTXO and history fetches are decided by the caller.
 */
async function scanBranch(
  wallet: MultisigWallet,
  branch: 0 | 1,
  minIndex: number,
  api: ChainApi
): Promise<{ used: ScannedAddress[]; nextIndex: number }> {
  const used: ScannedAddress[] = [];
  let gap = 0;
  let index = 0;
  let nextIndex = 0;

  while ((gap < GAP_LIMIT || index < minIndex) && index < MAX_ADDRESSES) {
    const batch: DerivedAddress[] = [];
    for (let i = 0; i < SCAN_BATCH; i++) batch.push(deriveAddress(wallet, branch, index + i));
    const stats = await Promise.all(batch.map((b) => api.addressStats(wallet.network, b.address)));
    for (let i = 0; i < batch.length; i++) {
      const txCount = stats[i].chain_stats.tx_count + stats[i].mempool_stats.tx_count;
      if (txCount > 0) {
        gap = 0;
        nextIndex = index + i + 1;
        used.push({
          info: { address: batch[i].address, branch, index: index + i, txCount },
          txCount,
          hasMempool: stats[i].mempool_stats.tx_count > 0,
        });
      } else {
        gap++;
      }
      if (gap >= GAP_LIMIT && index + i >= minIndex) break;
    }
    index += SCAN_BATCH;
  }
  return { used, nextIndex };
}

/**
 * Syncs a wallet against the chain. When `previous` is given, addresses whose
 * transaction count is unchanged — and that had no unconfirmed activity — keep
 * their cached coins and history instead of being fetched again.
 */
export async function syncWallet(
  wallet: MultisigWallet,
  previous?: WalletSync,
  api: ChainApi = defaultChainApi
): Promise<WalletSync> {
  const prevNext = {
    0: previous?.snapshot.nextReceiveIndex ?? 0,
    1: previous?.snapshot.nextChangeIndex ?? 0,
  };
  // One branch at a time: scanning both together doubles the burst of
  // per-address calls, which is what gets a public server to rate limit us.
  const receive = await scanBranch(wallet, 0, prevNext[0], api);
  const change = await scanBranch(wallet, 1, prevNext[1], api);
  const allUsed = [...receive.used, ...change.used];

  // An address needs re-fetching when it is new, when its transaction count
  // moved, or when it had unconfirmed activity last time (a confirmation does
  // not change the count, so the count alone cannot detect it).
  const prevUnconfirmed = new Set(
    (previous?.snapshot.utxos ?? []).filter((u) => !u.confirmed).map((u) => u.address)
  );
  const staleAddresses = new Set(
    allUsed
      .filter((u) => {
        const before = previous?.addressTxCounts[u.info.address];
        return before === undefined || before !== u.txCount || u.hasMempool || prevUnconfirmed.has(u.info.address);
      })
      .map((u) => u.info.address)
  );

  const stillUsed = new Set(allUsed.map((u) => u.info.address));
  const utxos: Utxo[] = (previous?.snapshot.utxos ?? []).filter(
    (u) => stillUsed.has(u.address) && !staleAddresses.has(u.address)
  );

  const refreshed = allUsed.filter((u) => staleAddresses.has(u.info.address));
  const fetched = await Promise.all(
    refreshed.map(async (u) => ({
      info: u.info,
      utxos: await api.utxos(wallet.network, u.info.address),
      txs: await api.addressTxs(wallet.network, u.info.address),
    }))
  );

  for (const entry of fetched) {
    for (const x of entry.utxos) {
      utxos.push({
        txid: x.txid,
        vout: x.vout,
        value: x.value,
        address: entry.info.address,
        branch: entry.info.branch,
        index: entry.info.index,
        confirmed: x.status.confirmed,
        blockHeight: x.status.block_height,
      });
    }
  }

  const snapshot: WalletSnapshot = {
    confirmedSats: utxos.filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0),
    unconfirmedSats: utxos.filter((u) => !u.confirmed).reduce((s, u) => s + u.value, 0),
    utxos,
    usedAddresses: allUsed.map((u) => u.info),
    nextReceiveIndex: Math.max(receive.nextIndex, prevNext[0]),
    nextChangeIndex: Math.max(change.nextIndex, prevNext[1]),
    scannedAt: Date.now(),
  };

  const history = mergeHistory(
    wallet,
    snapshot,
    previous?.history ?? [],
    fetched.flatMap((f) => f.txs),
    staleAddresses.size > 0
  );

  const addressTxCounts: Record<string, number> = {};
  for (const u of allUsed) addressTxCounts[u.info.address] = u.txCount;

  return { snapshot, history, addressTxCounts };
}

/**
 * Folds freshly fetched transactions into the cached history. Cached entries
 * are kept as-is unless the same txid came back in this sync (its
 * confirmation state may have moved on).
 */
function mergeHistory(
  wallet: MultisigWallet,
  snapshot: WalletSnapshot,
  cached: HistoryItem[],
  freshTxs: EsploraTx[],
  anythingChanged: boolean
): HistoryItem[] {
  if (!anythingChanged) return cached;
  const ours = new Set(snapshot.usedAddresses.map((a) => a.address));
  const byId = new Map<string, HistoryItem>(cached.map((h) => [h.txid, h]));

  for (const tx of freshTxs) {
    const spent = tx.vin.reduce(
      (s, v) => s + (v.prevout?.scriptpubkey_address && ours.has(v.prevout.scriptpubkey_address) ? v.prevout.value : 0),
      0
    );
    const received = tx.vout.reduce(
      (s, v) => s + (v.scriptpubkey_address && ours.has(v.scriptpubkey_address) ? v.value : 0),
      0
    );
    byId.set(tx.txid, {
      txid: tx.txid,
      netSats: received - spent,
      feeSats: tx.fee,
      confirmed: tx.status.confirmed,
      blockTime: tx.status.block_time,
    });
  }

  return [...byId.values()].sort((a, b) => {
    if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
    return (b.blockTime ?? 0) - (a.blockTime ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

export interface BuildResult {
  psbt: bitcoin.Psbt;
  feeSats: number;
  changeSats: number;
  usedUtxos: Utxo[];
  sendMax: boolean;
  /** True if any input is still in the mempool (a chained spend). */
  spendsUnconfirmed: boolean;
}

export function buildPsbt(
  wallet: MultisigWallet,
  snapshot: WalletSnapshot,
  toAddress: string,
  amountSats: number,
  feeRate: number,
  sendMax: boolean,
  /**
   * Coin control: outpoints ("txid:vout") to spend. Every one of them becomes
   * an input — the selection is the transaction, not a pool to pick from.
   */
  coinSelection?: string[]
): BuildResult {
  if (!(feeRate > 0)) throw new Error('The fee rate must be greater than zero.');
  const network = btcNetwork(wallet.network);
  const chosen = coinSelection ? new Set(coinSelection) : null;
  // Prefer confirmed coins: a child of an unconfirmed parent is refused by
  // some nodes and Electrum servers, and can never confirm before its parent.
  const spendable = [...snapshot.utxos]
    .filter((u) => !chosen || chosen.has(`${u.txid}:${u.vout}`))
    .sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
      return b.value - a.value;
    });

  // A chosen coin can be spent elsewhere between choosing and building. Say so
  // rather than quietly sending a transaction the user did not pick.
  if (chosen) {
    const missing = chosen.size - spendable.length;
    if (missing > 0) {
      throw new Error(
        `${missing} of the chosen coin${missing === 1 ? ' is' : 's are'} no longer available. Choose again.`
      );
    }
  }
  const totalAvailable = spendable.reduce((s, u) => s + u.value, 0);
  const changeAddr = deriveAddress(wallet, 1, snapshot.nextChangeIndex);
  const inputVb = multisigInputVbytes(wallet.m, wallet.n);

  let selected: Utxo[] = [];
  let fee = 0;
  let change = 0;

  if (sendMax) {
    selected = spendable;
    fee = Math.ceil(estimateVsize(wallet, selected.length, [toAddress]) * feeRate);
    amountSats = totalAvailable - fee;
    if (amountSats <= DUST_SATS) throw new Error('Not enough funds to cover the network fee.');
  } else {
    if (amountSats <= DUST_SATS) throw new Error(`Amount is below dust (${DUST_SATS} sats).`);
    let gathered = 0;
    for (const utxo of spendable) {
      selected.push(utxo);
      gathered += utxo.value;
      // Fee assuming a change output exists.
      fee = Math.ceil(estimateVsize(wallet, selected.length, [toAddress, changeAddr.address]) * feeRate);
      // Coin control spends every chosen coin, so never stop early.
      if (!chosen && gathered >= amountSats + fee) break;
    }
    if (gathered < amountSats + fee) {
      // Retry without change: maybe it fits exactly-ish.
      const feeNoChange = Math.ceil(estimateVsize(wallet, selected.length, [toAddress]) * feeRate);
      if (gathered >= amountSats + feeNoChange) {
        fee = gathered - amountSats; // everything left over goes to fee
      } else {
        throw new Error(
          `Not enough ${chosen ? 'in the chosen coins' : 'funds'}: need ${amountSats + fee} sats ` +
            `(including fee), have ${totalAvailable}.`
        );
      }
    } else {
      change = gathered - amountSats - fee;
      if (change <= DUST_SATS) {
        fee += change; // dust change → add to fee
        change = 0;
      }
    }
  }

  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);

  for (const utxo of selected) {
    const derived = deriveAddress(wallet, utxo.branch as 0 | 1, utxo.index);
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      sequence: 0xfffffffd, // opt-in RBF
      witnessUtxo: { script: derived.script, value: utxo.value },
      witnessScript: derived.witnessScript,
      bip32Derivation: derived.derivations.map((d) => ({
        pubkey: d.pubkey,
        masterFingerprint: d.masterFingerprint,
        path: d.path,
      })),
    });
  }

  psbt.addOutput({ address: toAddress.trim(), value: amountSats });
  if (change > 0) {
    psbt.addOutput({
      script: changeAddr.script,
      value: change,
      bip32Derivation: changeAddr.derivations.map((d) => ({
        pubkey: d.pubkey,
        masterFingerprint: d.masterFingerprint,
        path: d.path,
      })),
      witnessScript: changeAddr.witnessScript,
    });
  }

  return {
    psbt,
    feeSats: fee,
    changeSats: change,
    usedUtxos: selected,
    sendMax,
    spendsUnconfirmed: selected.some((u) => !u.confirmed),
  };
}

// ---------------------------------------------------------------------------
// PSBT inspection / signing / combining
// ---------------------------------------------------------------------------

/**
 * The PSBT inside whatever text arrived: bare base64 or hex, or a message
 * written around it. The signatures screen's "Send to Bob" wraps the
 * transaction in instructions, and the person pastes the whole message back.
 */
function psbtTextIn(input: string): string {
  const cleaned = input.trim();
  if (/^[0-9a-fA-F]+$/.test(cleaned) || /^[A-Za-z0-9+/=]+$/.test(cleaned)) return cleaned;
  // "psbt\xff" magic as base64, then as hex.
  const b64 = cleaned.match(/cHNidP8[A-Za-z0-9+/=]*/);
  if (b64) return b64[0];
  const hex = cleaned.match(/70736274ff[0-9a-fA-F]*/i);
  if (hex) return hex[0];
  return cleaned;
}

export function parsePsbt(input: string, networkName: MultisigWallet['network']): bitcoin.Psbt {
  const network = btcNetwork(networkName);
  const cleaned = psbtTextIn(input);
  try {
    if (/^[0-9a-fA-F]+$/.test(cleaned)) return bitcoin.Psbt.fromHex(cleaned, { network });
    return bitcoin.Psbt.fromBase64(cleaned, { network });
  } catch {
    throw new Error('That does not look like a valid transaction (PSBT).');
  }
}

/**
 * Bounds for a PSBT arriving from outside this phone (group relay, QR, NFC
 * tag, file). A genuine draft from this wallet is far smaller, and every
 * input and output is re-derived against the wallet's keys when the draft
 * is summarised — an oversized one is spam or an attack on memory and CPU.
 */
export const MAX_INCOMING_PSBT_CHARS = MAX_PSBT_CHARS; // ≈ 550 KB once decoded; the group protocol enforces the same bound
export const MAX_PSBT_INPUTS = 100;
export const MAX_PSBT_OUTPUTS = 100;
/**
 * How many unfinished drafts a wallet will accumulate from group messages
 * before new ones are ignored. A draft never moves funds on its own, but
 * an unbounded list is a spam vector against every member's phone.
 */
export const MAX_PENDING_DRAFTS = 10;

/** Whether a wallet holding `pendingCount` unfinished drafts has no room for another. */
export function atDraftLimit(pendingCount: number): boolean {
  return pendingCount >= MAX_PENDING_DRAFTS;
}

/**
 * The same limit for a draft the user brings in by hand (paste, QR, file).
 * Only they can fill the list that way, but one rule is easier to trust
 * than two, and they can finish or delete a draft. The relay loop, which
 * has no one to tell, just skips.
 */
export function assertDraftRoom(pendingCount: number): void {
  if (atDraftLimit(pendingCount)) {
    throw new Error(
      `This wallet already has ${MAX_PENDING_DRAFTS} unfinished transactions. Finish or delete one before adding another.`
    );
  }
}

/** parsePsbt plus the inbound size checks above. Use for anything not built here. */
export function parseIncomingPsbt(input: string, networkName: MultisigWallet['network']): bitcoin.Psbt {
  if (input.trim().length > MAX_INCOMING_PSBT_CHARS) {
    throw new Error('That transaction is far larger than a multisig draft should be — refusing to read it.');
  }
  const psbt = parsePsbt(input, networkName);
  if (psbt.data.inputs.length > MAX_PSBT_INPUTS || psbt.txOutputs.length > MAX_PSBT_OUTPUTS) {
    throw new Error('That transaction has an unreasonable number of inputs or outputs.');
  }
  return psbt;
}

/** txid of the unsigned template — stable across signing, used to match PSBT copies. */
export function unsignedTxId(psbt: bitcoin.Psbt): string {
  const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
  return tx.getId();
}

export interface PsbtSummary {
  /**
   * `isChange` here means "verified to return to this wallet": the output
   * script was re-derived from the wallet's own cosigner keys and matched.
   * A PSBT's own `bip32Derivation` metadata is never trusted for this — a
   * hostile draft can attach it to any address (see summarisePsbt).
   */
  outputs: { address: string; value: number; isChange: boolean }[];
  totalIn: number;
  totalOut: number;
  fee: number;
  /** Sats genuinely leaving the wallet (everything not verified change). */
  amountLeaving: number;
  /** Sats staying with the wallet as verified change. */
  changeTotal: number;
  /** fee as a fraction of the inputs spent, 0..1. */
  feeRatio: number;
  numInputs: number;
  /**
   * Every input's prevout script was re-derived from the wallet and matched.
   * When false the draft spends coins this wallet cannot account for — the
   * displayed totals cannot be trusted and the user must be warned.
   */
  allInputsOurs: boolean;
  /** Per input: number of signatures present. */
  sigCounts: number[];
  /** fingerprints (lowercase hex) that have signed every input. */
  signedBy: string[];
  complete: boolean;
  /**
   * More signatures than the quorum. A multisig spend must present exactly M
   * of them, so such a draft cannot be finalised until one is removed.
   */
  overSigned: boolean;
}

// A PSBT that lies about a derivation path could otherwise make us derive at
// an absurd index; genuine wallet output indices stay well below this.
const MAX_VERIFY_INDEX = 100_000;

/**
 * The branch/index a PSBT derivation entry claims, if it is a plausible
 * wallet path (last two components, standard receive/change branch). The
 * claim is only a hint — the caller re-derives and compares the script, so a
 * false claim simply fails to match.
 */
function claimedBranchIndex(
  deriv: { path: string }[] | undefined
): [number, number] | null {
  const path = deriv?.[0]?.path;
  if (!path) return null;
  const parts = path.split('/');
  if (parts.length < 2) return null;
  const index = Number(parts[parts.length - 1]);
  const branch = Number(parts[parts.length - 2].replace(/['h]/g, ''));
  if (!Number.isInteger(branch) || !Number.isInteger(index)) return null;
  if ((branch !== 0 && branch !== 1) || index < 0 || index > MAX_VERIFY_INDEX) return null;
  return [branch, index];
}

/** True only when the wallet itself derives `script` at the claimed path. */
function walletOwnsScript(
  wallet: MultisigWallet,
  deriv: { path: string }[] | undefined,
  script: Buffer | undefined
): boolean {
  if (!script) return false;
  const bi = claimedBranchIndex(deriv);
  if (!bi) return false;
  try {
    return deriveAddress(wallet, bi[0], bi[1]).script.equals(script);
  } catch {
    return false;
  }
}

export function summarisePsbt(psbt: bitcoin.Psbt, wallet: MultisigWallet): PsbtSummary {
  const network = btcNetwork(wallet.network);
  const totalIn = psbt.data.inputs.reduce((s, inp) => s + (inp.witnessUtxo?.value ?? 0), 0);
  const allInputsOurs =
    psbt.data.inputs.length > 0 &&
    psbt.data.inputs.every((inp) =>
      walletOwnsScript(wallet, inp.bip32Derivation, inp.witnessUtxo?.script as Buffer | undefined)
    );

  const outputs = psbt.txOutputs.map((out, i) => {
    let address = '(non-standard output)';
    try {
      address = bitcoin.address.fromOutputScript(out.script, network);
    } catch {}
    // Change is only what the wallet can actually re-derive to this exact
    // script — never merely what the PSBT tags with a derivation.
    const isChange = walletOwnsScript(wallet, psbt.data.outputs[i]?.bip32Derivation, out.script);
    return { address, value: out.value, isChange };
  });
  const totalOut = outputs.reduce((s, o) => s + o.value, 0);
  const changeTotal = outputs.filter((o) => o.isChange).reduce((s, o) => s + o.value, 0);
  const amountLeaving = outputs.filter((o) => !o.isChange).reduce((s, o) => s + o.value, 0);
  const fee = totalIn - totalOut;

  const sigCounts = psbt.data.inputs.map((inp) => inp.partialSig?.length ?? 0);

  // Which cosigners have signed all inputs? Match partialSig pubkeys against
  // each input's bip32Derivation entries.
  const signedBy: string[] = [];
  for (const cosigner of wallet.cosigners) {
    const signedAll = psbt.data.inputs.every((inp) => {
      const deriv = inp.bip32Derivation?.find(
        (d) => Buffer.from(d.masterFingerprint).toString('hex') === cosigner.fingerprint
      );
      if (!deriv) return false;
      return (inp.partialSig ?? []).some((s) => Buffer.from(s.pubkey).equals(Buffer.from(deriv.pubkey)));
    });
    if (signedAll && psbt.data.inputs.length > 0) signedBy.push(cosigner.fingerprint);
  }

  return {
    outputs,
    totalIn,
    totalOut,
    fee,
    amountLeaving,
    changeTotal,
    feeRatio: totalIn > 0 ? fee / totalIn : 0,
    numInputs: psbt.data.inputs.length,
    allInputsOurs,
    sigCounts,
    signedBy,
    complete: psbt.data.inputs.length > 0 && sigCounts.every((c) => c >= wallet.m),
    overSigned: sigCounts.some((c) => c > wallet.m),
  };
}

/**
 * Drops one cosigner's signatures from a draft.
 *
 * A P2WSH spend must present exactly M signatures — no more — so a draft that
 * collected a surplus cannot be finalised at all ("Too many signatures").
 * Removing one is the only way forward short of rebuilding the transaction.
 */
export function removeSignature(
  psbtBase64: string,
  network: MultisigWallet['network'],
  fingerprint: string
): string {
  const psbt = parsePsbt(psbtBase64, network);
  const wanted = fingerprint.toLowerCase();
  let removed = 0;

  for (const input of psbt.data.inputs) {
    const derivation = input.bip32Derivation?.find(
      (d) => Buffer.from(d.masterFingerprint).toString('hex') === wanted
    );
    if (!derivation || !input.partialSig) continue;
    const keep = input.partialSig.filter(
      (s) => !Buffer.from(s.pubkey).equals(Buffer.from(derivation.pubkey))
    );
    removed += input.partialSig.length - keep.length;
    // Leaving an empty array behind would serialise as a signed-but-empty
    // input; drop the field entirely instead.
    if (keep.length > 0) input.partialSig = keep;
    else delete input.partialSig;
  }

  if (removed === 0) {
    throw new Error('That key has not signed this transaction.');
  }
  return psbt.toBase64();
}

/** Sign every input we can with a local mnemonic. Returns how many inputs got a new signature. */
export function signPsbtWithMnemonic(psbt: bitcoin.Psbt, mnemonic: string, wallet: MultisigWallet): number {
  const root = rootFromMnemonic(mnemonic, wallet.network);
  let signed = 0;
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    try {
      psbt.signInputHD(i, root);
      signed++;
    } catch {
      // already signed by this key, or this input has no derivation for it
    }
  }
  return signed;
}

/**
 * What a card needs to sign each input it owns: the BIP143 sighash and the
 * branch/index below the account. Inputs the given fingerprint does not own,
 * or has already signed, are skipped.
 */
export interface InputSigningJob {
  index: number;
  digest: Buffer;
  subpath: [number, number];
  pubkey: Buffer;
}

export function signingJobsFor(
  psbtBase64: string,
  fingerprint: string,
  network: MultisigWallet['network']
): InputSigningJob[] {
  const psbt = parsePsbt(psbtBase64, network);
  const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
  const jobs: InputSigningJob[] = [];

  psbt.data.inputs.forEach((input, index) => {
    const derivation = input.bip32Derivation?.find(
      (d) => Buffer.from(d.masterFingerprint).toString('hex') === fingerprint.toLowerCase()
    );
    if (!derivation || !input.witnessScript || !input.witnessUtxo) return;
    // Already signed by this key — nothing to ask the card for.
    if ((input.partialSig ?? []).some((s) => Buffer.from(s.pubkey).equals(Buffer.from(derivation.pubkey)))) {
      return;
    }
    const steps = derivation.path.split('/').slice(-2).map((s) => parseInt(s, 10));
    if (steps.length !== 2 || steps.some((s) => !Number.isInteger(s))) {
      throw new Error(`Cannot read the key path "${derivation.path}" for input ${index}.`);
    }
    jobs.push({
      index,
      digest: tx.hashForWitnessV0(
        index,
        Buffer.from(input.witnessScript),
        input.witnessUtxo.value,
        bitcoin.Transaction.SIGHASH_ALL
      ),
      subpath: [steps[0], steps[1]],
      pubkey: Buffer.from(derivation.pubkey),
    });
  });
  return jobs;
}

/**
 * Folds signatures produced elsewhere (a card, a remote signer) into a PSBT.
 * Each signature is verified against its digest first, so a bad one is
 * rejected here rather than at broadcast.
 */
export function attachSignatures(
  psbtBase64: string,
  network: MultisigWallet['network'],
  signed: { job: InputSigningJob; signature: Buffer }[]
): string {
  const psbt = parsePsbt(psbtBase64, network);
  for (const { job, signature } of signed) {
    if (!ecc.verify(job.digest, job.pubkey, signature)) {
      throw new Error(`The signature for input ${job.index} does not match this transaction.`);
    }
    psbt.updateInput(job.index, {
      partialSig: [
        {
          pubkey: job.pubkey,
          signature: bitcoin.script.signature.encode(signature, bitcoin.Transaction.SIGHASH_ALL),
        },
      ],
    });
  }
  return psbt.toBase64();
}

/** Merge signatures from another copy of the same PSBT. */
export function combinePsbts(ours: bitcoin.Psbt, theirs: bitcoin.Psbt): bitcoin.Psbt {
  ours.combine(theirs);
  return ours;
}

/**
 * A draft is finished when the chain has moved past it: either the
 * transaction itself is in our history, or one of the coins it spends is no
 * longer unspent — which happens the moment it is broadcast, and also when a
 * competing transaction spends the same coin. Either way it can never be
 * broadcast again, so it is not "awaiting signatures".
 */
export function isDraftSettled(
  psbtBase64: string,
  network: MultisigWallet['network'],
  unspentOutpoints: Set<string>,
  historyTxids: Set<string>
): boolean {
  const psbt = parsePsbt(psbtBase64, network);
  if (historyTxids.has(unsignedTxId(psbt))) return true;
  return psbt.txInputs.some((input) => {
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    return !unspentOutpoints.has(`${txid}:${input.index}`);
  });
}

/** "txid:vout" keys for everything the wallet can currently spend. */
export function outpointKeys(utxos: Utxo[]): Set<string> {
  return new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
}

export interface MergeResult {
  /** The combined PSBT — unchanged from `ourBase64` when nothing was added. */
  base64: string;
  /** True when their copy carried at least one signature ours lacked. */
  added: boolean;
}

/**
 * Folds another party's copy of the same transaction into ours.
 * Throws if the two are different transactions, so a stray PSBT can never
 * silently replace the one being signed.
 */
export function mergeSignatures(
  ourBase64: string,
  theirBase64: string,
  network: MultisigWallet['network']
): MergeResult {
  const ours = parsePsbt(ourBase64, network);
  // Their copy comes from outside — a relay, a QR, a file — so it is
  // size-checked before any merging work happens on it.
  const theirs = parseIncomingPsbt(theirBase64, network);
  if (unsignedTxId(ours) !== unsignedTxId(theirs)) {
    throw new Error('That is a different transaction — it cannot be merged with this one.');
  }
  ours.combine(theirs);
  const base64 = ours.toBase64();
  return { base64, added: base64 !== ourBase64 };
}

export function finalizeAndExtract(psbt: bitcoin.Psbt): string {
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}

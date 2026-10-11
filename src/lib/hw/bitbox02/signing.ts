import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha256';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { bip32, btcNetwork, deriveAddress } from '../../bitcoin';
import { Cosigner, MultisigWallet, NetworkName } from '../../types';
import { Message } from '../protobuf';
import { MultisigSignRequest } from '../types';
import { BTCCoin, BTCOutputType, FormatUnit, MultisigScriptType } from './messages';

/**
 * Turns a wallet and a PSBT into what the BitBox02 is told, without talking
 * to it. Kept apart from the device so every decision here — above all which
 * outputs are presented as the wallet's own — can be tested on its own.
 */

export const HARDENED = 0x80000000;
/** The firmware's limits. */
export const MULTISIG_NAME_MAX_LEN = 30;
const MAX_COSIGNERS = 15;
const MAX_RECEIVE_INDEX = 9999;
const MAX_LOCKTIME = 500_000_000;
const ALLOWED_SEQUENCES = [0xffffffff, 0xfffffffe, 0xfffffffd];

// ---------------------------------------------------------------------------
// Paths and keys
// ---------------------------------------------------------------------------

/** "m/48'/0'/0'/2'/1/7" → [0x80000030, 0x80000000, 0x80000000, 0x80000002, 1, 7] */
export function parseKeypath(path: string): number[] {
  const steps = path.trim().replace(/^m\/?/i, '').split('/').filter(Boolean);
  return steps.map((step) => {
    const match = /^(\d+)(['hH]?)$/.exec(step);
    const value = match ? Number(match[1]) : NaN;
    if (!match || !Number.isInteger(value) || value >= HARDENED) {
      throw new Error(`Cannot read the key path "${path}".`);
    }
    return match[2] ? value + HARDENED : value;
  });
}

export function formatKeypath(keypath: number[]): string {
  return ['m', ...keypath.map((k) => (k >= HARDENED ? `${k - HARDENED}'` : String(k)))].join('/');
}

/** True for the paths the device exports without first asking "are you sure?". */
export function isStandardMultisigPath(keypath: number[], network: NetworkName): boolean {
  const coin = (network === 'mainnet' ? 0 : 1) + HARDENED;
  if (keypath.length !== 3 && keypath.length !== 4) return false;
  if (keypath[0] !== 48 + HARDENED || keypath[1] !== coin) return false;
  if (keypath[2] < HARDENED || keypath[2] > HARDENED + 99) return false;
  return keypath.length === 3 || keypath[3] === 1 + HARDENED || keypath[3] === 2 + HARDENED;
}

export function coinFor(network: NetworkName): number {
  return network === 'mainnet' ? BTCCoin.BTC : BTCCoin.TBTC;
}

/** The 74 bytes of an extended key that identify it — everything but the version prefix. */
export function xpubIdentity(xpub: string): Buffer {
  const raw = Buffer.from(bs58check.decode(xpub));
  if (raw.length !== 78) throw new Error('That is not an extended public key.');
  return Buffer.from(raw.subarray(4));
}

/** An extended public key as the device takes it: the fields, without the version prefix. */
export function xpubMessage(xpub: string): Message {
  const body = xpubIdentity(xpub);
  return {
    depth: Buffer.from(body.subarray(0, 1)),
    parent_fingerprint: Buffer.from(body.subarray(1, 5)),
    child_num: body.readUInt32BE(5),
    chain_code: Buffer.from(body.subarray(9, 41)),
    public_key: Buffer.from(body.subarray(41, 74)),
  };
}

// ---------------------------------------------------------------------------
// The wallet, as the device registers it
// ---------------------------------------------------------------------------

export interface WalletOnDevice {
  coin: number;
  cosigner: Cosigner;
  /** The device's own account path, e.g. m/48'/0'/0'/2'. */
  accountKeypath: number[];
  /** BTCScriptConfig */
  scriptConfig: Message;
}

export function describeWallet(wallet: MultisigWallet, fingerprint: string): WalletOnDevice {
  const wanted = fingerprint.toLowerCase();
  const ourIndex = wallet.cosigners.findIndex((c) => c.fingerprint.toLowerCase() === wanted);
  if (ourIndex < 0) throw new Error(`Key ${wanted} is not one of this wallet’s cosigners.`);
  const n = wallet.cosigners.length;
  if (n < 2 || n > MAX_COSIGNERS) {
    throw new Error(`The BitBox02 signs for wallets of 2 to ${MAX_COSIGNERS} cosigners; this one has ${n}.`);
  }
  if (!Number.isInteger(wallet.m) || wallet.m < 1 || wallet.m > n) {
    throw new Error(`This wallet’s policy (${wallet.m} of ${n}) is not one the BitBox02 can sign for.`);
  }
  const identities = wallet.cosigners.map((c) => xpubIdentity(c.xpub).toString('hex'));
  if (new Set(identities).size !== identities.length) {
    throw new Error('This wallet lists the same key twice, which the BitBox02 does not accept.');
  }
  const cosigner = wallet.cosigners[ourIndex];
  const accountKeypath = parseKeypath(cosigner.path);
  if (accountKeypath.length === 0) throw new Error('This wallet’s key has no derivation path.');
  return {
    coin: coinFor(wallet.network),
    cosigner,
    accountKeypath,
    scriptConfig: {
      multisig: {
        threshold: wallet.m,
        xpubs: wallet.cosigners.map((c) => xpubMessage(c.xpub)),
        our_xpub_index: ourIndex,
        script_type: MultisigScriptType.P2WSH,
      },
    },
  };
}

/**
 * A short code that commits to the wallet's keys and policy, used to tell two
 * wallets of the same name apart on the device.
 */
export function walletTag(wallet: MultisigWallet): string {
  const keys = wallet.cosigners.map((c) => xpubIdentity(c.xpub).toString('hex')).sort();
  const digest = sha256(Buffer.from(`${wallet.network}:${wallet.m}:${keys.join(',')}`, 'utf8'));
  return Buffer.from(digest.subarray(0, 2)).toString('hex');
}

/**
 * The name the wallet is registered under. The device takes 1 to 30 printable
 * ASCII characters with no space at either end, so anything else in the
 * wallet's name is dropped. `distinct` adds the wallet tag, for when the plain
 * name is already taken by another wallet on the device.
 */
export function registrationName(wallet: MultisigWallet, distinct = false): string {
  const suffix = distinct ? ` ${walletTag(wallet)}` : '';
  const room = MULTISIG_NAME_MAX_LEN - suffix.length;
  const clean = wallet.name
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, room)
    .trim();
  return (clean || `${wallet.m}-of-${wallet.cosigners.length} multisig`.slice(0, room)) + suffix;
}

// ---------------------------------------------------------------------------
// The transaction, as the device is walked through it
// ---------------------------------------------------------------------------

export interface PlannedPrevTx {
  /** BTCPrevTxInitRequest */
  init: Message;
  /** BTCPrevTxInputRequest, one per input of the previous transaction. */
  inputs: Message[];
  /** BTCPrevTxOutputRequest */
  outputs: Message[];
}

export interface PlannedInput {
  /** BTCSignInputRequest, before the anti-klepto commitment is added. */
  request: Message;
  prevTx: PlannedPrevTx;
  /** The key the device signs this input with, as the wallet derives it. */
  pubkey: Buffer;
  /** BIP143 digest, computed here — what a returned signature must verify against. */
  sighash: Buffer;
}

export interface SignPlan {
  /** BTCSignInitRequest */
  init: Message;
  inputs: PlannedInput[];
  /** BTCSignOutputRequest */
  outputs: Message[];
}

export interface FirmwareAbilities {
  /** v9.15.0: an output to the wallet's receive branch may be presented as the wallet's own. */
  ownReceiveOutputs: boolean;
  /** v9.24.0: OP_RETURN outputs. */
  opReturnOutputs: boolean;
}

interface Derivation {
  masterFingerprint: Uint8Array;
  path: string;
  pubkey: Uint8Array;
}

/**
 * Where below the account a derivation entry claims to sit, if it is ours and
 * is a plausible wallet path. Only a claim: the caller re-derives the script
 * and compares, so a false one simply fails to match.
 */
function claimedPosition(
  derivations: Derivation[] | undefined,
  fingerprint: string,
  accountKeypath: number[]
): { branch: number; index: number; keypath: number[] } | null {
  const ours = derivations?.find(
    (d) => Buffer.from(d.masterFingerprint).toString('hex') === fingerprint.toLowerCase()
  );
  if (!ours) return null;
  let keypath: number[];
  try {
    keypath = parseKeypath(ours.path);
  } catch {
    return null;
  }
  if (keypath.length !== accountKeypath.length + 2) return null;
  if (accountKeypath.some((step, i) => keypath[i] !== step)) return null;
  const [branch, index] = keypath.slice(-2);
  if ((branch !== 0 && branch !== 1) || index >= HARDENED) return null;
  return { branch, index, keypath };
}

function prevTxPlan(tx: bitcoin.Transaction): PlannedPrevTx {
  return {
    init: {
      version: tx.version >>> 0,
      num_inputs: tx.ins.length,
      num_outputs: tx.outs.length,
      locktime: tx.locktime,
    },
    inputs: tx.ins.map((input) => ({
      prev_out_hash: Buffer.from(input.hash),
      prev_out_index: input.index,
      signature_script: Buffer.from(input.script),
      sequence: input.sequence,
    })),
    outputs: tx.outs.map((output) => ({
      value: output.value,
      pubkey_script: Buffer.from(output.script),
    })),
  };
}

/** How an address that is not the wallet's is described: its kind, and the hash or key inside it. */
export function externalPayload(
  script: Buffer,
  abilities: FirmwareAbilities
): { type: number; payload: Buffer } {
  const n = script.length;
  if (n === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return { type: BTCOutputType.P2PKH, payload: Buffer.from(script.subarray(3, 23)) };
  }
  if (n === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { type: BTCOutputType.P2SH, payload: Buffer.from(script.subarray(2, 22)) };
  }
  if (n === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return { type: BTCOutputType.P2WPKH, payload: Buffer.from(script.subarray(2)) };
  }
  if (n === 34 && script[0] === 0x00 && script[1] === 0x20) {
    return { type: BTCOutputType.P2WSH, payload: Buffer.from(script.subarray(2)) };
  }
  if (n === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return { type: BTCOutputType.P2TR, payload: Buffer.from(script.subarray(2)) };
  }
  if (n > 1 && script[0] === 0x6a) {
    if (!abilities.opReturnOutputs) {
      throw new Error('This BitBox02’s firmware is too old to sign a transaction carrying data (OP_RETURN). Update it in the BitBoxApp.');
    }
    // One data push after OP_RETURN, which is all the device displays.
    const chunks = bitcoin.script.decompile(script);
    if (chunks && chunks.length === 2) {
      if (Buffer.isBuffer(chunks[1])) return { type: BTCOutputType.OP_RETURN, payload: Buffer.from(chunks[1]) };
      if (chunks[1] === bitcoin.opcodes.OP_0) return { type: BTCOutputType.OP_RETURN, payload: Buffer.alloc(0) };
    }
  }
  throw new Error('The BitBox02 cannot show one of this transaction’s outputs (unrecognised kind of address).');
}

export function planSigning(request: MultisigSignRequest, abilities: FirmwareAbilities): SignPlan {
  const { wallet, psbt } = request;
  const fingerprint = request.fingerprint.toLowerCase();
  const onDevice = describeWallet(wallet, fingerprint);
  const accountXpub = bip32.fromBase58(onDevice.cosigner.xpub, btcNetwork(wallet.network));

  // Checked first: a transaction without inputs does not even parse back.
  if (psbt.data.inputs.length === 0) throw new Error('This transaction has nothing to sign.');
  const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
  if (tx.version !== 1 && tx.version !== 2) {
    throw new Error(`The BitBox02 signs version 1 and 2 transactions; this one is version ${tx.version}.`);
  }
  if (tx.locktime >= MAX_LOCKTIME) {
    throw new Error('The BitBox02 does not sign transactions locked until a calendar time.');
  }

  const inputs: PlannedInput[] = psbt.data.inputs.map((input, i) => {
    const label = `Input ${i + 1}`;
    if (input.sighashType !== undefined && input.sighashType !== bitcoin.Transaction.SIGHASH_ALL) {
      throw new Error(`${label} asks for an unusual signature type, which the BitBox02 does not make.`);
    }
    if (!ALLOWED_SEQUENCES.includes(tx.ins[i].sequence)) {
      throw new Error(`${label} uses a sequence number the BitBox02 does not sign.`);
    }
    if (!input.witnessUtxo || !input.witnessScript) {
      throw new Error(`${label} is missing the details of the coin it spends.`);
    }
    // The device checks amounts against the transactions the coins came from
    // — a segwit signature alone does not commit to the total being spent.
    if (!input.nonWitnessUtxo) {
      throw new Error(`${label} is missing its previous transaction, which the BitBox02 needs to check the amount.`);
    }
    const position = claimedPosition(input.bip32Derivation, fingerprint, onDevice.accountKeypath);
    // The device signs all of a transaction's inputs or none of them.
    if (!position) {
      throw new Error(`${label} is not one this BitBox02’s key can sign, and the BitBox02 only signs a transaction whose every input is its own.`);
    }
    const derived = deriveAddress(wallet, position.branch, position.index);
    const prevoutScript = Buffer.from(input.witnessUtxo.script);
    if (!derived.script.equals(prevoutScript) || !derived.witnessScript.equals(Buffer.from(input.witnessScript))) {
      throw new Error(`${label} spends a coin that does not belong to this wallet.`);
    }

    const prevTx = bitcoin.Transaction.fromBuffer(Buffer.from(input.nonWitnessUtxo));
    if (!Buffer.from(prevTx.getHash()).equals(Buffer.from(tx.ins[i].hash))) {
      throw new Error(`${label} comes with a previous transaction that is not the one it spends.`);
    }
    const spent = prevTx.outs[tx.ins[i].index];
    if (!spent || spent.value !== input.witnessUtxo.value || !Buffer.from(spent.script).equals(prevoutScript)) {
      throw new Error(`${label} does not match the coin in its previous transaction.`);
    }
    if (spent.value <= 0) throw new Error(`${label} spends an empty coin.`);

    return {
      request: {
        prevOutHash: Buffer.from(tx.ins[i].hash),
        prevOutIndex: tx.ins[i].index,
        prevOutValue: spent.value,
        sequence: tx.ins[i].sequence,
        keypath: position.keypath,
        script_config_index: 0,
      },
      prevTx: prevTxPlan(prevTx),
      pubkey: Buffer.from(accountXpub.derive(position.branch).derive(position.index).publicKey),
      sighash: Buffer.from(
        tx.hashForWitnessV0(i, derived.witnessScript, spent.value, bitcoin.Transaction.SIGHASH_ALL)
      ),
    };
  });

  const outputs: Message[] = tx.outs.map((output, i) => {
    const script = Buffer.from(output.script);
    const position = claimedPosition(psbt.data.outputs[i]?.bip32Derivation, fingerprint, onDevice.accountKeypath);
    // An output is only ever presented as the wallet's own when the wallet
    // itself derives that exact script. What the PSBT says about it is a hint
    // about where to look, never the answer — a hostile draft can attach a
    // derivation to any address.
    const ours =
      position !== null &&
      position.index <= MAX_RECEIVE_INDEX &&
      (position.branch === 1 || abilities.ownReceiveOutputs) &&
      deriveAddress(wallet, position.branch, position.index).script.equals(script);
    if (ours) {
      return { ours: true, value: output.value, keypath: position.keypath, script_config_index: 0 };
    }
    const { type, payload } = externalPayload(script, abilities);
    if (output.value <= 0 && type !== BTCOutputType.OP_RETURN) {
      throw new Error(`Output ${i + 1} sends nothing, which the BitBox02 does not sign.`);
    }
    return { ours: false, type, value: output.value, payload };
  });

  return {
    init: {
      coin: onDevice.coin,
      script_configs: [{ script_config: onDevice.scriptConfig, keypath: onDevice.accountKeypath }],
      version: tx.version,
      num_inputs: inputs.length,
      num_outputs: outputs.length,
      locktime: tx.locktime,
      format_unit: FormatUnit.DEFAULT,
    },
    inputs,
    outputs,
  };
}

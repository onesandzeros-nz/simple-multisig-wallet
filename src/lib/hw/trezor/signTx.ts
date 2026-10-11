import * as bitcoin from 'bitcoinjs-lib';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { bip32, btcNetwork, deriveAddress } from '../../bitcoin';
import { MultisigWallet } from '../../types';
import { Message } from '../protobuf';
import { HardwareSignature, MultisigSignRequest } from '../types';
import {
  InputScriptType,
  MessageType,
  MultisigPubkeysOrder,
  OutputScriptType,
  RequestType,
  SignTx,
  TxAck,
} from './messages';
import { TrezorSession } from './session';

/**
 * Signing a P2WSH multisig spend on a Trezor.
 *
 * A Trezor is not handed a PSBT. It is told how many inputs and outputs there
 * are and then asks for each piece in the order it wants them — the inputs,
 * the outputs, and every previous transaction an input spends — hashing as it
 * goes, showing the outputs on its screen, and finally handing back one
 * signature per input. Everything it is sent here is rebuilt from the wallet's
 * own keys first; the PSBT's metadata is only ever a hint about where to look.
 *
 * Reference: trezor-firmware docs/common/communication/bitcoin-signing.md,
 * HWI hwilib/devices/trezor.py.
 */

/** Trezor's own ceiling on a multisig. */
const MAX_COSIGNERS = 15;
/** Matches what the wallet engine will re-derive when it checks a draft. */
const MAX_INDEX = 100_000;
const HARDENED = 0x80000000;

/** "m/48'/0'/0'/2'" → [0x80000030, 0x80000000, 0x80000000, 0x80000002]. Accepts ' and h. */
export function parsePath(path: string): number[] {
  const steps = path.trim().replace(/^m\/?/i, '').split('/').filter(Boolean);
  if (steps.length > 10) throw new Error(`The key path "${path}" is too deep.`);
  return steps.map((step) => {
    const match = /^(\d+)(['hH]?)$/.exec(step);
    const value = match ? Number(match[1]) : NaN;
    if (!match || !Number.isInteger(value) || value >= HARDENED) {
      throw new Error(`Cannot read the key path "${path}".`);
    }
    return match[2] ? (value + HARDENED) >>> 0 : value;
  });
}

/** Strict DER (as Trezor returns it, without the sighash byte) → 64 bytes r‖s. */
export function derToCompact(der: Uint8Array): Buffer {
  try {
    // bitcoinjs checks BIP66 strictness and pads r and s to 32 bytes each.
    const decoded = bitcoin.script.signature.decode(
      Buffer.concat([Buffer.from(der), Buffer.from([bitcoin.Transaction.SIGHASH_ALL])])
    );
    return Buffer.from(decoded.signature);
  } catch {
    throw new Error('The Trezor returned a signature this app cannot read.');
  }
}

interface PrevTx {
  version: number;
  lockTime: number;
  inputs: Message[];
  outputs: Message[];
}

export interface SigningPlan {
  coinName: 'Bitcoin' | 'Testnet';
  version: number;
  lockTime: number;
  /** TxInputType for each input, in order. */
  inputs: Message[];
  /** TxOutputType for each output, in order. */
  outputs: Message[];
  /** Previous transactions by txid as it is displayed (big-endian hex). */
  prevTxs: Map<string, PrevTx>;
  /** Per input: the key that must have signed and the digest it must have signed. */
  expected: { pubkey: Buffer; digest: Buffer }[];
}

/**
 * The branch and index a PSBT entry claims for this cosigner. Only a claim:
 * the caller derives the script at that position and compares.
 */
function claimedPosition(
  derivations: { masterFingerprint: Uint8Array; path: string }[] | undefined,
  fingerprint: string
): [number, number] | null {
  const ours = derivations?.find((d) => Buffer.from(d.masterFingerprint).toString('hex') === fingerprint);
  if (!ours) return null;
  const parts = ours.path.split('/');
  if (parts.length < 2) return null;
  const [branch, index] = parts.slice(-2).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if ((branch !== 0 && branch !== 1) || !Number.isInteger(index) || index < 0 || index > MAX_INDEX) return null;
  return [branch, index];
}

/**
 * How the device is told about the multisig at one address: every cosigner's
 * account key, and the two steps below it.
 *
 * Firmware from 2025 on (2.8.7, 1.13.0) sorts the derived keys itself when
 * told the order is lexicographic. Older firmware ignores that field and
 * takes the keys in the order given — so they are given in the order the
 * script has them, which is right for both.
 */
function multisigAt(
  wallet: MultisigWallet,
  nodes: Message[],
  derived: { pubkey: Buffer }[],
  branch: number,
  index: number
): Message {
  const order = derived.map((_, i) => i).sort((a, b) => derived[a].pubkey.compare(derived[b].pubkey));
  return {
    nodes: order.map((i) => nodes[i]),
    address_n: [branch, index],
    m: wallet.m,
    // One empty slot per cosigner; the device fills in its own.
    signatures: derived.map(() => Buffer.alloc(0)),
    pubkeys_order: MultisigPubkeysOrder.LEXICOGRAPHIC,
  };
}

function prevTxOf(tx: bitcoin.Transaction): PrevTx {
  return {
    // bitcoinjs reads the version as signed; on the wire, and to Trezor, it is not.
    version: tx.version >>> 0,
    lockTime: tx.locktime,
    inputs: tx.ins.map((input) => ({
      // Trezor names transactions the way people read them: reversed.
      prev_hash: Buffer.from(input.hash).reverse(),
      prev_index: input.index,
      script_sig: Buffer.from(input.script),
      sequence: input.sequence,
    })),
    outputs: tx.outs.map((output) => ({
      amount: output.value,
      script_pubkey: Buffer.from(output.script),
    })),
  };
}

/**
 * Works out everything the device will ask for, checking each piece against
 * the wallet on the way. Throws — before the device is involved — on a
 * transaction this wallet cannot account for.
 */
export function planSigning(request: MultisigSignRequest): SigningPlan {
  const { wallet, psbt } = request;
  const fingerprint = request.fingerprint.toLowerCase();
  const network = btcNetwork(wallet.network);

  if (wallet.scriptType !== 'P2WSH') throw new Error('Only native segwit (P2WSH) wallets can be signed for.');
  if (wallet.cosigners.length < 1 || wallet.cosigners.length > MAX_COSIGNERS || wallet.m < 1 || wallet.m > wallet.cosigners.length) {
    throw new Error(`A Trezor can sign for wallets of up to ${MAX_COSIGNERS} keys; this one is ${wallet.m} of ${wallet.cosigners.length}.`);
  }
  const ourIndex = wallet.cosigners.findIndex((c) => c.fingerprint.toLowerCase() === fingerprint);
  if (ourIndex < 0) throw new Error(`The key ${fingerprint} is not part of this wallet.`);
  const accountPath = parsePath(wallet.cosigners[ourIndex].path);

  const nodes: Message[] = wallet.cosigners.map((c) => {
    const node = bip32.fromBase58(c.xpub, network);
    return {
      depth: node.depth,
      fingerprint: node.parentFingerprint >>> 0,
      child_num: node.index >>> 0,
      chain_code: Buffer.from(node.chainCode),
      public_key: Buffer.from(node.publicKey),
    };
  });

  const unsigned = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
  if (unsigned.ins.length === 0 || unsigned.outs.length === 0) {
    throw new Error('This transaction has no inputs or no outputs.');
  }

  const inputs: Message[] = [];
  const expected: SigningPlan['expected'] = [];
  const prevTxs = new Map<string, PrevTx>();

  unsigned.ins.forEach((txInput, i) => {
    const input = psbt.data.inputs[i];
    const label = `Input ${i + 1}`;
    if (!input?.witnessUtxo || !input.witnessScript) {
      throw new Error(`${label} is missing the details of the coin it spends.`);
    }
    if (input.sighashType !== undefined && input.sighashType !== bitcoin.Transaction.SIGHASH_ALL) {
      throw new Error(`${label} asks for an unusual signature type, which a Trezor will not produce.`);
    }
    const position = claimedPosition(input.bip32Derivation, fingerprint);
    if (!position) throw new Error(`${label} does not say where this key sits in the wallet.`);
    const [branch, index] = position;

    // The PSBT says this coin is ours; the wallet's own keys have the last word.
    const derived = deriveAddress(wallet, branch, index);
    const prevScript = Buffer.from(input.witnessUtxo.script);
    if (!derived.script.equals(prevScript) || !derived.witnessScript.equals(Buffer.from(input.witnessScript))) {
      throw new Error(`${label} spends a coin that does not belong to this wallet.`);
    }

    // The device checks the amount against the previous transaction, so the
    // previous transaction has to be the real one.
    if (!input.nonWitnessUtxo) {
      throw new Error(`${label} is missing the transaction it spends from, which a Trezor needs to check the amount.`);
    }
    let prev: bitcoin.Transaction;
    try {
      prev = bitcoin.Transaction.fromBuffer(Buffer.from(input.nonWitnessUtxo));
    } catch {
      throw new Error(`${label} carries a previous transaction that cannot be read.`);
    }
    if (!Buffer.from(prev.getHash()).equals(Buffer.from(txInput.hash))) {
      throw new Error(`${label} carries a previous transaction that is not the one it spends.`);
    }
    const spent = prev.outs[txInput.index];
    if (!spent || !Buffer.from(spent.script).equals(prevScript) || spent.value !== input.witnessUtxo.value) {
      throw new Error(`${label} does not match the transaction it spends from.`);
    }
    prevTxs.set(prev.getId(), prevTxOf(prev));

    inputs.push({
      address_n: [...accountPath, branch, index],
      prev_hash: Buffer.from(txInput.hash).reverse(),
      prev_index: txInput.index,
      sequence: txInput.sequence,
      script_type: InputScriptType.SPENDWITNESS,
      multisig: multisigAt(wallet, nodes, derived.derivations, branch, index),
      amount: spent.value,
    });
    expected.push({
      pubkey: derived.derivations[ourIndex].pubkey,
      digest: unsigned.hashForWitnessV0(i, derived.witnessScript, spent.value, bitcoin.Transaction.SIGHASH_ALL),
    });
  });

  const outputs: Message[] = unsigned.outs.map((txOutput, i) => {
    const script = Buffer.from(txOutput.script);
    // Change is an output on the change branch that the wallet itself derives
    // to this exact script — never merely one the PSBT labels as ours. The
    // device derives it again from what it is given, and only then hides it.
    const position = claimedPosition(psbt.data.outputs[i]?.bip32Derivation, fingerprint);
    if (position && position[0] === 1) {
      const derived = deriveAddress(wallet, position[0], position[1]);
      if (derived.script.equals(script)) {
        return {
          address_n: [...accountPath, position[0], position[1]],
          amount: txOutput.value,
          script_type: OutputScriptType.PAYTOWITNESS,
          multisig: multisigAt(wallet, nodes, derived.derivations, position[0], position[1]),
        };
      }
    }

    const chunks = bitcoin.script.decompile(script);
    if (chunks && chunks[0] === bitcoin.opcodes.OP_RETURN) {
      const data = chunks.slice(1);
      if (txOutput.value !== 0 || data.length !== 1 || !Buffer.isBuffer(data[0])) {
        throw new Error(`Output ${i + 1} is a kind of data output a Trezor will not sign.`);
      }
      return {
        amount: 0,
        script_type: OutputScriptType.PAYTOOPRETURN,
        op_return_data: Buffer.from(data[0]),
      };
    }

    let address: string;
    try {
      address = bitcoin.address.fromOutputScript(script, network);
    } catch {
      throw new Error(`Output ${i + 1} does not pay to an address, so a Trezor cannot show or sign it.`);
    }
    return { address, amount: txOutput.value, script_type: OutputScriptType.PAYTOADDRESS };
  });

  return {
    coinName: wallet.network === 'mainnet' ? 'Bitcoin' : 'Testnet',
    version: unsigned.version >>> 0,
    lockTime: unsigned.locktime,
    inputs,
    outputs,
    prevTxs,
    expected,
  };
}

/**
 * Answers one request from the device with the piece of the plan it asked for.
 * Exported for tests; `runSigning` is what callers use.
 */
export function answerRequest(plan: SigningPlan, request: Message): Message {
  const kind: number = request.request_type ?? RequestType.TXINPUT;
  const details: Message = request.details ?? {};
  const index: number | undefined = details.request_index;
  const hash: Buffer | undefined = details.tx_hash && details.tx_hash.length > 0 ? details.tx_hash : undefined;

  const at = <T>(list: T[], what: string): T => {
    if (index === undefined || index < 0 || index >= list.length) {
      throw new Error(`The Trezor asked for ${what} ${index ?? '?'}, which this transaction does not have.`);
    }
    return list[index];
  };

  if (hash) {
    const prev = plan.prevTxs.get(Buffer.from(hash).toString('hex'));
    if (!prev) throw new Error('The Trezor asked about a transaction this one does not spend from.');
    switch (kind) {
      case RequestType.TXMETA:
        return {
          version: prev.version,
          lock_time: prev.lockTime,
          inputs_cnt: prev.inputs.length,
          outputs_cnt: prev.outputs.length,
          extra_data_len: 0,
        };
      case RequestType.TXINPUT:
        return { inputs: [at(prev.inputs, 'input')] };
      case RequestType.TXOUTPUT:
        return { bin_outputs: [at(prev.outputs, 'output')] };
    }
  } else {
    switch (kind) {
      case RequestType.TXINPUT:
        return { inputs: [at(plan.inputs, 'input')] };
      case RequestType.TXOUTPUT:
        return { outputs: [at(plan.outputs, 'output')] };
    }
  }
  // Replacement transactions, payment requests, extra data: nothing this app builds has them.
  throw new Error('The Trezor asked for something this kind of transaction does not have.');
}

/** Sends the plan to the device piece by piece and collects what it signs. */
export async function runSigning(session: TrezorSession, plan: SigningPlan): Promise<HardwareSignature[]> {
  const collected: (Buffer | undefined)[] = plan.inputs.map(() => undefined);

  // A well-behaved device asks for each piece a handful of times at most.
  let pieces = plan.inputs.length + plan.outputs.length + 1;
  for (const prev of plan.prevTxs.values()) pieces += prev.inputs.length + prev.outputs.length + 1;
  const maxRounds = pieces * 6 + 50;

  let request = await session.call(
    MessageType.SignTx,
    SignTx,
    {
      outputs_count: plan.outputs.length,
      inputs_count: plan.inputs.length,
      coin_name: plan.coinName,
      version: plan.version,
      lock_time: plan.lockTime,
      // Only the signatures are wanted; the transaction is assembled here.
      serialize: false,
    },
    MessageType.TxRequest
  );

  for (let round = 0; ; round++) {
    let answer: Message;
    try {
      if (round > maxRounds) throw new Error('The Trezor kept asking for the same things without finishing.');

      const serialized: Message | undefined = request.serialized;
      if (serialized && serialized.signature_index !== undefined && serialized.signature?.length) {
        const i: number = serialized.signature_index;
        if (i >= collected.length) throw new Error('The Trezor signed an input this transaction does not have.');
        if (collected[i] && !collected[i]!.equals(serialized.signature)) {
          throw new Error(`The Trezor sent two different signatures for input ${i + 1}.`);
        }
        collected[i] = Buffer.from(serialized.signature);
      }
      if (request.request_type === RequestType.TXFINISHED) break;
      answer = answerRequest(plan, request);
    } catch (e) {
      // The refusal is ours: the device is still waiting mid-transaction, so
      // call it off rather than leave it sitting on a signing screen.
      await session.cancel();
      throw e;
    }
    request = await session.call(MessageType.TxAck, TxAck, { tx: answer }, MessageType.TxRequest);
  }

  return collected.map((der, index) => {
    if (!der) throw new Error(`The Trezor did not sign input ${index + 1}.`);
    const signature = derToCompact(der);
    const { pubkey, digest } = plan.expected[index];
    // Checked here so that a wrong device, a wrong passphrase or a device
    // shown a different transaction is named as such, not found at broadcast.
    if (!ecc.verify(digest, pubkey, signature)) {
      throw new Error(
        `The Trezor's signature for input ${index + 1} does not match this transaction and key. ` +
          'Check it is the right device, with the right passphrase if it uses one.'
      );
    }
    return { index, pubkey, signature };
  });
}

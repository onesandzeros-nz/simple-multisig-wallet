import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { bip48Path } from '../bitcoin';
import { normaliseXpub } from '../slip132';
import { Cosigner, MultisigWallet, NetworkName } from '../types';
import { attachSignatures, parsePsbt, signingJobsFor, summarisePsbt } from '../wallet';
import { HardwareDevice, HardwareKey } from './types';

/**
 * What the app does with a connected device, whichever make it is: read its
 * key, or have it sign. The drivers only speak their device's protocol; the
 * checks that protect the wallet live here, once, for all of them.
 */

/** Returns a whole transaction as hex. It is verified before use, so any source will do. */
export type FetchTx = (network: NetworkName, txid: string) => Promise<string>;

/**
 * Reads the account key a wallet would use from the device, and makes sure it
 * is a usable public key on the right network before anything is built on it.
 */
export async function readKeyFromDevice(
  device: HardwareDevice,
  network: NetworkName,
  path: string = bip48Path(network)
): Promise<HardwareKey> {
  const key = await device.getKey(network, path);
  const normalised = normaliseXpub(key.xpub);
  if (normalised.network !== network) {
    throw new Error(
      `The device returned a ${normalised.network} key, but this needs a ${network} one. ` +
        `Check which app or account is open on the device.`
    );
  }
  const fingerprint = String(key.fingerprint ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
    throw new Error('The device did not say which key this is (no master fingerprint).');
  }
  return { xpub: normalised.xpub, fingerprint, path, network };
}

/**
 * Fills in the transaction each input spends from.
 *
 * A segwit input's amount is only a claim until the transaction that created
 * it is seen, and a hardware wallet shown a false amount would display a
 * false fee — so they ask for the whole previous transaction. Whatever the
 * server sends is checked here: it must hash to the txid the input names, and
 * the output it spends must be the one the transaction was built against.
 */
export async function withPreviousTransactions(
  psbt: bitcoin.Psbt,
  network: NetworkName,
  fetchTx: FetchTx
): Promise<void> {
  const fetched = new Map<string, Buffer>();
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const input = psbt.data.inputs[i];
    const txInput = psbt.txInputs[i];
    const txid = Buffer.from(txInput.hash).reverse().toString('hex');

    let raw = input.nonWitnessUtxo ? Buffer.from(input.nonWitnessUtxo) : fetched.get(txid);
    if (!raw) {
      let hex: string;
      try {
        hex = await fetchTx(network, txid);
      } catch (e: any) {
        throw new Error(
          `Could not fetch a transaction this one spends from, which the device needs to check the amounts. ` +
            `(${e?.message ?? e})`
        );
      }
      if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('The server returned a malformed transaction.');
      raw = Buffer.from(hex, 'hex');
    }

    let previous: bitcoin.Transaction;
    try {
      previous = bitcoin.Transaction.fromBuffer(raw);
    } catch {
      throw new Error('The server returned a transaction that could not be read.');
    }
    if (previous.getId() !== txid) {
      throw new Error('The server returned a different transaction from the one asked for — refusing to use it.');
    }
    const spent = previous.outs[txInput.index];
    if (!spent) throw new Error(`Input ${i} spends an output its transaction does not have.`);
    if (input.witnessUtxo) {
      const claimed = input.witnessUtxo;
      if (claimed.value !== spent.value || !Buffer.from(claimed.script).equals(Buffer.from(spent.script))) {
        throw new Error(
          `Input ${i} does not match the transaction it spends from: the amount or address is wrong. ` +
            `Do not sign this.`
        );
      }
    }

    fetched.set(txid, raw);
    if (!input.nonWitnessUtxo) psbt.updateInput(i, { nonWitnessUtxo: raw });
  }
}

export interface DeviceSigningResult {
  /** The stored transaction with the device's signatures added. */
  base64: string;
  /** Which of the wallet's keys the device turned out to hold. */
  cosigner: Cosigner;
  /** How many inputs gained a signature. */
  signedInputs: number;
}

/**
 * Finds the cosigner a connected device can sign for, proving it with the
 * key itself. A fingerprint alone is not proof: it is four bytes of text in a
 * wallet file, and a device opened with a different passphrase shows a
 * different one anyway.
 */
export async function cosignerForDevice(
  device: HardwareDevice,
  wallet: MultisigWallet,
  expectFingerprint?: string
): Promise<Cosigner> {
  const fingerprint = (await device.masterFingerprint()).toLowerCase();
  const expected = expectFingerprint?.toLowerCase();
  if (expected && fingerprint !== expected) {
    const named = wallet.cosigners.find((c) => c.fingerprint.toLowerCase() === expected);
    throw new Error(
      `That is a different key. The device holds ${fingerprint}, but ` +
        `${named ? `“${named.name}”` : 'this signature'} needs ${expected}. ` +
        `Check it is the right device — and the right passphrase, if it uses one.`
    );
  }
  const cosigner = wallet.cosigners.find((c) => c.fingerprint.toLowerCase() === fingerprint);
  if (!cosigner) {
    throw new Error(
      `The key on this device (${fingerprint}) is not one of the ${wallet.n} keys in “${wallet.name}”. ` +
        `Check it is the right device — and the right passphrase, if it uses one.`
    );
  }
  const key = await readKeyFromDevice(device, wallet.network, cosigner.path);
  if (key.xpub !== cosigner.xpub) {
    throw new Error(
      `The device has the fingerprint of “${cosigner.name}” but a different key at ${cosigner.path}. ` +
        `It cannot sign for this wallet.`
    );
  }
  return cosigner;
}

/**
 * Has a connected device sign the inputs it owns and folds the signatures
 * into the transaction. The stored copy never carries the previous
 * transactions — they are only added to what the device is shown.
 */
export async function signPsbtWithDevice(options: {
  device: HardwareDevice;
  wallet: MultisigWallet;
  psbtBase64: string;
  fetchTx: FetchTx;
  /** Sign as this cosigner only; otherwise as whichever one the device holds. */
  expectFingerprint?: string;
  status?: (message: string) => void;
}): Promise<DeviceSigningResult> {
  const { device, wallet, psbtBase64, fetchTx } = options;
  const status = options.status ?? (() => {});

  status('Checking the device holds one of this wallet’s keys…');
  const cosigner = await cosignerForDevice(device, wallet, options.expectFingerprint);

  const psbt = parsePsbt(psbtBase64, wallet.network);
  // A hardware wallet decides what is change by re-deriving it, and so must
  // be told the truth about every input. A draft spending coins this wallet
  // cannot account for would have it sign something it cannot display.
  if (!summarisePsbt(psbt, wallet).allInputsOurs) {
    throw new Error(
      'This transaction spends coins that are not from this wallet, so a hardware wallet cannot check it. ' +
        'It was not sent to the device.'
    );
  }

  const jobs = signingJobsFor(psbtBase64, cosigner.fingerprint, wallet.network);
  if (jobs.length === 0) {
    throw new Error(`“${cosigner.name}” has already signed this transaction.`);
  }

  status('Fetching the transactions being spent from…');
  await withPreviousTransactions(psbt, wallet.network, fetchTx);

  const signatures = await device.signMultisig({ wallet, psbt, fingerprint: cosigner.fingerprint });

  const signed = jobs.map((job) => {
    const mine = signatures.find((s) => s.index === job.index);
    if (!mine) throw new Error(`The device did not sign input ${job.index}. Nothing was changed.`);
    if (!Buffer.from(mine.pubkey).equals(job.pubkey)) {
      throw new Error(
        `The device signed input ${job.index} with a different key from the one this wallet expects. ` +
          `Nothing was changed.`
      );
    }
    if (mine.signature.length !== 64) {
      throw new Error(`The device returned a malformed signature for input ${job.index}.`);
    }
    return { job, signature: Buffer.from(mine.signature) };
  });

  // attachSignatures verifies each one against the sighash computed here, from
  // the stored transaction — not from anything the device was sent or said.
  const base64 = attachSignatures(psbtBase64, wallet.network, signed);
  return { base64, cosigner, signedInputs: signed.length };
}

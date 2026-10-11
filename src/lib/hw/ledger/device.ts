import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { bip48Path, deriveAddress } from '../../bitcoin';
import { normaliseXpub } from '../../slip132';
import { MultisigWallet, NetworkName } from '../../types';
import {
  DeviceInfo,
  DriverOptions,
  HardwareDevice,
  HardwareKey,
  HardwareSignature,
  MultisigSignRequest,
  PacketTransport,
} from '../types';
import {
  ApduChannel,
  ApduResponse,
  buildApdu,
  checkStatus,
  LedgerStatusError,
  SW_CLA_NOT_SUPPORTED,
  SW_DEVICE_LOCKED,
  SW_INCORRECT_DATA,
  SW_INS_NOT_SUPPORTED,
  SW_INTERRUPTED_EXECUTION,
  SW_NOT_SUPPORTED,
  SW_OK,
  SW_SIGNATURE_FAIL,
} from './framing';
import { ClientCommandInterpreter } from './interpreter';
import { decodeVarint, encodeVarint, MerkleMap, MerkleTree } from './merkle';
import { hmacMemoryKey, multisigPolicy, policyId, serialisePolicy, WalletPolicy } from './policy';
import { psbtToV2Maps } from './psbt';

/**
 * The Ledger Bitcoin app, version 2.1.0 and later.
 *
 * Reference: github.com/LedgerHQ/app-bitcoin-new doc/bitcoin.md and its
 * bitcoin_client_js; HWI's hwilib/devices/ledger.py for how a coordinator
 * uses it for multisig.
 */

const CLA_BOLOS = 0xb0;
const CLA_BITCOIN = 0xe1;
const CLA_FRAMEWORK = 0xf8;

const INS_GET_APP_AND_VERSION = 0x01;
const INS_GET_EXTENDED_PUBKEY = 0x00;
const INS_REGISTER_WALLET = 0x02;
const INS_GET_WALLET_ADDRESS = 0x03;
const INS_SIGN_PSBT = 0x04;
const INS_GET_MASTER_FINGERPRINT = 0x05;
const INS_CONTINUE = 0x01;

/** P2 names the protocol version; 1 is what apps from 2.1.0 speak. */
const PROTOCOL_VERSION = 1;

/** Anything the app answers by itself. A Nano S can take seconds over a single key. */
const QUICK_TIMEOUT_MS = 20_000;
/** Anything the user reads and approves on the device. */
const USER_TIMEOUT_MS = 5 * 60_000;

/** A sanity bound on a conversation; a hundred-input transaction needs a few thousand rounds. */
const MAX_ROUNDS = 100_000;

const SIGHASH_ALL = 0x01;

const MODELS: Record<number, string> = {
  0x10: 'Ledger Nano S',
  0x40: 'Ledger Nano X',
  0x50: 'Ledger Nano S Plus',
  0x60: 'Ledger Stax',
  0x70: 'Ledger Flex',
  0x80: 'Ledger Nano Gen5',
};

/** The model a USB product id stands for. The high byte names it; the low byte lists its interfaces. */
export function ledgerModel(productId: number | undefined): string {
  if (productId === undefined) return 'Ledger';
  // The first Nano S and Nano X shipped with ids from before that scheme.
  if (productId === 0x0001) return MODELS[0x10];
  if (productId === 0x0004) return MODELS[0x40];
  return MODELS[productId >> 8] ?? 'Ledger';
}

export interface LedgerApp {
  name: string;
  version: string;
  /** Which network's keys and transactions this app handles; null when it is not a Bitcoin app. */
  network: NetworkName | null;
  /** Speaks the protocol from before 2.1.0, which this driver does not. */
  legacy: boolean;
}

/** Reads the reply to "which app is open?". */
export function parseAppAndVersion(data: Uint8Array): LedgerApp {
  const buf = Buffer.from(data);
  let at = 0;
  const field = (): Buffer => {
    if (at >= buf.length) throw new Error('The Ledger gave an unreadable answer about which app is open.');
    const length = buf[at];
    const value = Buffer.from(buf.subarray(at + 1, at + 1 + length));
    if (value.length !== length) throw new Error('The Ledger gave an unreadable answer about which app is open.');
    at += 1 + length;
    return value;
  };
  if (buf.length < 1 || buf[at++] !== 1) {
    throw new Error('The Ledger gave an unreadable answer about which app is open.');
  }
  const name = field().toString('ascii');
  const version = field().toString('ascii');

  const [major, minor] = version.split('.').map((part) => parseInt(part, 10));
  const isBitcoin = /^Bitcoin( Test(net)?)?( Legacy| Recovery)?$/.test(name);
  return {
    name,
    version,
    network: !isBitcoin ? null : /Test/.test(name) ? 'testnet' : 'mainnet',
    legacy: /Legacy/.test(name) || !(major > 2 || (major === 2 && minor >= 1)),
  };
}

function encodePath(path: string): Buffer {
  const steps = path
    .trim()
    .replace(/^m\/?/i, '')
    .split('/')
    .filter(Boolean)
    .map((step) => {
      const match = /^(\d+)(['hH]?)$/.exec(step);
      if (!match || Number(match[1]) >= 0x80000000) throw new Error(`Cannot read the key path "${path}".`);
      return (Number(match[1]) + (match[2] ? 0x80000000 : 0)) >>> 0;
    });
  if (steps.length > 8) throw new Error(`The key path "${path}" is longer than a Ledger accepts.`);
  const out = Buffer.alloc(1 + 4 * steps.length);
  out[0] = steps.length;
  steps.forEach((step, i) => out.writeUInt32BE(step, 1 + 4 * i));
  return out;
}

function normalisePath(path: string): string {
  const steps = path
    .trim()
    .replace(/^m\/?/i, '')
    .split('/')
    .filter(Boolean)
    .map((step) => step.replace(/[hH]$/, "'"));
  return ['m', ...steps].join('/');
}

/** One yielded result of SIGN_PSBT: input index, the key that signed, and the signature as it goes on the stack. */
export function parseYieldedSignature(yielded: Uint8Array): HardwareSignature {
  const buf = Buffer.from(yielded);
  const index = decodeVarint(buf, 0);
  // Tags above 65535 announce MuSig2 results, which a plain multisig never produces.
  if (index.value > 0xffff) throw new Error('The Ledger returned a kind of signature this app does not use.');
  const keyLength = buf[index.next];
  const pubkey = Buffer.from(buf.subarray(index.next + 1, index.next + 1 + keyLength));
  const signature = Buffer.from(buf.subarray(index.next + 1 + keyLength));
  if (keyLength !== 33 || pubkey.length !== 33) {
    throw new Error('The Ledger signed with a kind of key this wallet does not use.');
  }
  let decoded: { signature: Buffer; hashType: number };
  try {
    decoded = bitcoin.script.signature.decode(signature);
  } catch {
    throw new Error('The Ledger returned a signature that cannot be read.');
  }
  // Anything else would let outputs or inputs change after signing.
  if (decoded.hashType !== SIGHASH_ALL) {
    throw new Error('The Ledger returned a signature that does not cover the whole transaction.');
  }
  return { index: index.value, pubkey, signature: Buffer.from(decoded.signature) };
}

export class LedgerDevice implements HardwareDevice {
  readonly kind = 'ledger' as const;

  private readonly channel: ApduChannel;
  private app: LedgerApp | null = null;
  private fingerprint: string | null = null;
  /** Keys already read this session, so a path the device has to be asked about is asked about once. */
  private readonly keys = new Map<string, HardwareKey>();

  constructor(
    private readonly transport: PacketTransport,
    private readonly options: DriverOptions,
    /** What USB said about the device, for naming the model. */
    private readonly usb: { productId?: number } = {}
  ) {
    this.channel = new ApduChannel(transport);
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async connect(): Promise<DeviceInfo> {
    const model = ledgerModel(this.usb.productId);
    const reply = await this.channel.exchange(
      buildApdu(CLA_BOLOS, INS_GET_APP_AND_VERSION, 0, 0),
      QUICK_TIMEOUT_MS
    );
    if (reply.sw === SW_DEVICE_LOCKED) {
      throw new Error('The Ledger is locked. Unlock it with its PIN, open the Bitcoin app, then try again.');
    }
    // Firmware too old to say which app is open is, at least, not in one we can use.
    if (reply.sw === SW_CLA_NOT_SUPPORTED || reply.sw === SW_INS_NOT_SUPPORTED) {
      throw new Error(this.openAppMessage());
    }
    checkStatus(reply, 'checking which app is open');

    const app = parseAppAndVersion(reply.data);
    if (app.network === null) {
      // "BOLOS" is the home screen; older firmware calls it "OLOS".
      throw new Error(
        /^B?OLOS/.test(app.name)
          ? this.openAppMessage()
          : `The Ledger has its ${app.name} app open. ${this.openAppMessage()}`
      );
    }
    if (app.legacy) {
      throw new Error(
        `This Ledger is running ${app.name} ${app.version}, which is too old to sign for a multisig wallet. ` +
          'Update the Bitcoin app in Ledger Live to version 2.1.0 or later' +
          (/Legacy/.test(app.name) ? ', and open that rather than the Legacy app.' : '.')
      );
    }
    this.app = app;
    return { model, firmware: `${app.name} ${app.version}` };
  }

  private openAppMessage(): string {
    return 'Open the Bitcoin app on the Ledger (“Bitcoin Test” for a testnet wallet), then try again.';
  }

  /** The app found by connect(), checked against the network about to be used. */
  private requireApp(network: NetworkName): LedgerApp {
    if (!this.app) throw new Error('The Ledger has not been connected yet.');
    if (this.app.network !== network) {
      throw new Error(
        network === 'mainnet'
          ? `The Ledger has its ${this.app.name} app open, which only handles testnet. Open the Bitcoin app instead, then try again.`
          : `The Ledger has its ${this.app.name} app open, but this is a testnet wallet. Open the Bitcoin Test app instead, then try again.`
      );
    }
    return this.app;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * One command, start to finish: send it, answer the app's questions until
   * it stops asking, return its final reply.
   */
  private async command(
    ins: number,
    data: Uint8Array,
    timeoutMs: number,
    interpreter?: ClientCommandInterpreter
  ): Promise<ApduResponse> {
    let reply = await this.channel.exchange(buildApdu(CLA_BITCOIN, ins, 0, PROTOCOL_VERSION, data), timeoutMs);
    for (let round = 0; reply.sw === SW_INTERRUPTED_EXECUTION; round++) {
      if (!interpreter || round >= MAX_ROUNDS) {
        throw new Error('The Ledger asked for something it should not need here.');
      }
      const answer = interpreter.execute(reply.data);
      reply = await this.channel.exchange(
        buildApdu(CLA_FRAMEWORK, INS_CONTINUE, 0, PROTOCOL_VERSION, answer),
        timeoutMs
      );
    }
    return reply;
  }

  async masterFingerprint(): Promise<string> {
    if (this.fingerprint) return this.fingerprint;
    const reply = await this.command(INS_GET_MASTER_FINGERPRINT, new Uint8Array(0), QUICK_TIMEOUT_MS);
    checkStatus(reply, 'reading its fingerprint');
    if (reply.data.length !== 4) throw new Error('The Ledger gave an unreadable fingerprint.');
    this.fingerprint = reply.data.toString('hex');
    return this.fingerprint;
  }

  async getKey(network: NetworkName, path: string = bip48Path(network)): Promise<HardwareKey> {
    this.requireApp(network);
    const known = this.keys.get(normalisePath(path));
    if (known) return known;
    const encoded = encodePath(path);
    const ask = (display: boolean, timeoutMs: number) =>
      this.command(INS_GET_EXTENDED_PUBKEY, Buffer.concat([Buffer.from([display ? 1 : 0]), encoded]), timeoutMs);

    let reply = await ask(false, QUICK_TIMEOUT_MS);
    if (reply.sw === SW_NOT_SUPPORTED) {
      // Not one of the paths the app hands out unasked; it will after showing
      // the path on its own screen.
      this.options.prompts.status(`Approve exporting the key at ${normalisePath(path)} on the Ledger.`);
      reply = await ask(true, USER_TIMEOUT_MS);
      if (reply.sw === SW_NOT_SUPPORTED) {
        // Since 2.4.3 the app cannot leave its own network's part of the key
        // tree at all, whatever the user would be willing to approve.
        throw new LedgerStatusError(
          `The Ledger will not hand out the key at ${normalisePath(path)}. Its ${this.app!.name} app only ` +
            `exports keys for ${network} wallets, from paths such as ${bip48Path(network)}.`,
          reply.sw
        );
      }
    }
    checkStatus(reply, 'reading the key');

    let key;
    try {
      key = normaliseXpub(reply.data.toString('ascii'));
    } catch {
      throw new Error('The Ledger returned something that is not a public key.');
    }
    // The app name said which network; the key it produced has to agree.
    if (key.network !== network) {
      throw new Error(`The Ledger returned a ${key.network} key where a ${network} one was asked for.`);
    }
    const result: HardwareKey = {
      xpub: key.xpub,
      fingerprint: await this.masterFingerprint(),
      path: normalisePath(path),
      network,
    };
    this.keys.set(result.path, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Wallet registration
  // -------------------------------------------------------------------------

  /**
   * Shows the wallet on the device — name, policy, every cosigner's key — and
   * returns the device's approval of it: a MAC over the policy, which the app
   * wants back with every later use since it keeps no record of its own.
   */
  private async register(wallet: MultisigWallet, policy: WalletPolicy): Promise<Buffer> {
    this.options.prompts.status(
      `The Ledger needs to approve this wallet before it will sign for it. Check the name “${policy.name}”, ` +
        `the policy (${wallet.m} of ${wallet.cosigners.length}) and every cosigner key on its screen, then approve.`
    );
    const interpreter = new ClientCommandInterpreter();
    interpreter.addPolicy(policy);
    const serialised = serialisePolicy(policy);
    const reply = await this.command(
      INS_REGISTER_WALLET,
      Buffer.concat([encodeVarint(serialised.length), serialised]),
      USER_TIMEOUT_MS,
      interpreter
    );
    if (reply.sw === SW_NOT_SUPPORTED) {
      throw new LedgerStatusError(
        `The Bitcoin app on this Ledger cannot hold a ${wallet.m} of ${wallet.cosigners.length} wallet. ` +
          'Updating the app in Ledger Live may help.',
        reply.sw
      );
    }
    checkStatus(reply, 'registering the wallet');
    if (reply.data.length !== 64) throw new Error('The Ledger gave an unreadable answer to the wallet registration.');
    if (!Buffer.from(reply.data.subarray(0, 32)).equals(policyId(policy))) {
      throw new Error('The Ledger approved a different wallet from the one it was sent.');
    }
    const hmac = Buffer.from(reply.data.subarray(32));

    // What the user approved was a description. Check the device turns it
    // into the same first address this app does before relying on it.
    const expected = deriveAddress(wallet, 0, 0).address;
    const actual = await this.walletAddress(policy, hmac, 0, 0, false);
    if (actual !== expected) {
      throw new Error(
        `The Ledger and this app disagree about the wallet’s first address (${actual} against ${expected}). ` +
          'Nothing was signed.'
      );
    }
    return hmac;
  }

  private async walletAddress(
    policy: WalletPolicy,
    hmac: Buffer,
    branch: 0 | 1,
    index: number,
    display: boolean
  ): Promise<string> {
    const interpreter = new ClientCommandInterpreter();
    interpreter.addPolicy(policy);
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32BE(index, 0);
    const reply = await this.command(
      INS_GET_WALLET_ADDRESS,
      Buffer.concat([Buffer.from([display ? 1 : 0]), policyId(policy), hmac, Buffer.from([branch]), indexBytes]),
      display ? USER_TIMEOUT_MS : QUICK_TIMEOUT_MS,
      interpreter
    );
    checkStatus(reply, 'working out an address');
    return reply.data.toString('ascii');
  }

  /**
   * Checks this device is the cosigner it is about to sign as, before it is
   * asked anything — so the wrong Ledger, or the right one opened with a
   * different passphrase, is named as such rather than refused obscurely.
   */
  private async requireCosigner(wallet: MultisigWallet, fingerprint: string): Promise<void> {
    const wanted = fingerprint.toLowerCase();
    const actual = await this.masterFingerprint();
    if (actual !== wanted) {
      throw new Error(`That is a different Ledger. It holds key ${actual}, but this signature needs ${wanted}.`);
    }
    const cosigner = wallet.cosigners.find((c) => c.fingerprint.toLowerCase() === wanted);
    if (!cosigner) throw new Error(`Key ${wanted} is not one of this wallet’s cosigners.`);
    const key = await this.getKey(wallet.network, cosigner.path);
    if (key.xpub !== cosigner.xpub) {
      throw new Error(
        `This Ledger has the right fingerprint (${wanted}) but a different key at ${key.path} from the one in ` +
          'this wallet. Check the wallet was built with the key from this device.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  private async signPsbt(
    psbt: bitcoin.Psbt,
    policy: WalletPolicy,
    hmac: Buffer
  ): Promise<ApduResponse & { yielded: Buffer[] }> {
    const maps = psbtToV2Maps(psbt);
    const global = new MerkleMap(maps.global);
    const inputs = maps.inputs.map((m) => new MerkleMap(m));
    const outputs = maps.outputs.map((m) => new MerkleMap(m));
    const inputCommitments = inputs.map((m) => m.commitment());
    const outputCommitments = outputs.map((m) => m.commitment());

    const total = inputs.length;
    const interpreter = new ClientCommandInterpreter((count) =>
      this.options.prompts.status(`Signing on the Ledger… ${Math.min(count, total)} of ${total}`)
    );
    interpreter.addPolicy(policy);
    interpreter.addMap(global);
    for (const map of [...inputs, ...outputs]) interpreter.addMap(map);
    interpreter.addList(inputCommitments);
    interpreter.addList(outputCommitments);

    const reply = await this.command(
      INS_SIGN_PSBT,
      Buffer.concat([
        global.commitment(),
        encodeVarint(inputs.length),
        new MerkleTree(inputCommitments).root,
        encodeVarint(outputs.length),
        new MerkleTree(outputCommitments).root,
        policyId(policy),
        hmac,
      ]),
      USER_TIMEOUT_MS,
      interpreter
    );
    return { ...reply, yielded: interpreter.yielded };
  }

  async signMultisig(request: MultisigSignRequest): Promise<HardwareSignature[]> {
    const { wallet, psbt } = request;
    this.requireApp(wallet.network);
    await this.requireCosigner(wallet, request.fingerprint);
    const fingerprint = request.fingerprint.toLowerCase();

    const policy = multisigPolicy(wallet);
    const memoryKey = hmacMemoryKey(fingerprint, policy);
    // Losing the approval costs a second look at the device, nothing more —
    // so trouble reading or writing it is never a reason to fail a signature.
    const stored = await this.options.memory.get(memoryKey).catch((e) => {
      console.warn(`[ledger] could not read the stored wallet approval: ${e?.message ?? e}`);
      return null;
    });
    let hmac: Buffer | null = stored && /^[0-9a-f]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : null;
    const remembered = hmac !== null;

    const registerNow = async (): Promise<Buffer> => {
      const fresh = await this.register(wallet, policy);
      await this.options.memory.set(memoryKey, fresh.toString('hex')).catch((e) => {
        console.warn(`[ledger] could not store the wallet approval: ${e?.message ?? e}`);
      });
      return fresh;
    };
    if (!hmac) hmac = await registerNow();

    const review = 'Review the transaction on the Ledger — the amount, the address and the fee — then approve it.';
    this.options.prompts.status(review);
    let result = await this.signPsbt(psbt, policy, hmac);
    if (result.sw === SW_SIGNATURE_FAIL && remembered) {
      // The approval on file is not this device's: it was reset, or restored
      // from another seed with the same fingerprint. Ask again.
      hmac = await registerNow();
      this.options.prompts.status(review);
      result = await this.signPsbt(psbt, policy, hmac);
    }
    if (result.sw === SW_INCORRECT_DATA && result.data.length === 2) {
      const code = result.data.readUInt16BE(0);
      console.warn(`[ledger] signing refused: sw=0x6a80 detail=0x${code.toString(16).padStart(4, '0')}`);
      throw new LedgerStatusError(describeSigningRefusal(code), result.sw, code);
    }
    checkStatus(result, 'signing the transaction');

    const signatures = result.yielded.map(parseYieldedSignature);
    if (signatures.some((s) => s.index >= psbt.data.inputs.length)) {
      throw new Error('The Ledger signed an input this transaction does not have.');
    }
    if (signatures.length === 0) {
      throw new Error(
        'The Ledger approved the transaction but signed nothing — none of its inputs belong to this key.'
      );
    }
    return signatures;
  }
}

/** The error codes newer apps attach when refusing a transaction (src/error_codes.h). */
function describeSigningRefusal(code: number): string {
  switch (code) {
    case 0x0002:
      return 'The Ledger does not recognise any key in this wallet as its own.';
    case 0x0003:
    case 0x0007:
      return 'The Ledger needs the coins being spent described in the transaction, and one is missing.';
    case 0x0004:
    case 0x0005:
      return 'The Ledger found that a coin being spent does not match the transaction it is said to come from. Nothing was signed.';
    case 0x000a:
      return 'The Ledger found an input whose script does not belong to this wallet. Nothing was signed.';
    case 0x000d:
      return 'The Ledger will not sign this kind of transaction unless “Allow non-standard sighash” is switched on in its Bitcoin app settings.';
    default:
      return `The Ledger could not accept this transaction (code ${code}).`;
  }
}

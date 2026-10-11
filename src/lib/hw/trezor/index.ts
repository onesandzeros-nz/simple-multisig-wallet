import * as bitcoin from 'bitcoinjs-lib';
import * as bs58check from 'bs58check';
import { Buffer } from 'buffer';
import { bip32, bip48Path, btcNetwork } from '../../bitcoin';
import { normaliseXpub } from '../../slip132';
import { NetworkName } from '../../types';
import { Message } from '../protobuf';
import {
  DeviceInfo,
  DriverOptions,
  HardwareDevice,
  HardwareKey,
  HardwareSignature,
  MultisigSignRequest,
  PacketTransport,
} from '../types';
import { FailureType, GetPublicKey, InputScriptType, MessageType, PublicKey } from './messages';
import { THP_ONLY_MESSAGE, TrezorSession } from './session';
import { parsePath, planSigning, runSigning } from './signTx';

/**
 * Trezor Model One, Model T, Safe 3 and Safe 5 over USB, speaking the
 * original unencrypted protocol. The Safe 7 only speaks its successor (THP)
 * and is recognised and turned away.
 *
 * Reference: trezor-firmware common/protob and docs/common, python trezorlib,
 * HWI hwilib/devices/trezor.py.
 */

/**
 * The oldest firmware this driver will sign with, per major version (1 is the
 * Model One, 2 is everything since).
 *
 * In 1.9.1 and 2.3.1 Trezor began checking the amount of a segwit input
 * against the transaction it comes from; before that, a lying host could make
 * the device sign away a fee of any size. 2.3.4 rather than 2.3.1 because it
 * is the oldest Model T firmware this driver has actually been run against.
 */
export const MIN_FIRMWARE: Record<1 | 2, [number, number, number]> = {
  1: [1, 9, 1],
  2: [2, 3, 4],
};

const HARDENED = 0x80000000;

function modelName(features: Message): string {
  const model: string | undefined = features.model;
  // Model One firmware from before 2019 did not say what it was.
  if (!model || model === '1') return 'Trezor Model One';
  if (model === 'T') return 'Trezor Model T';
  return `Trezor ${model}`;
}

function formatPath(steps: number[]): string {
  return ['m', ...steps.map((s) => (s >= HARDENED ? `${s - HARDENED}'` : `${s}`))].join('/');
}

function olderThan(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] < minimum[i];
  }
  return false;
}

/**
 * BIP32 serialisation of a public node, from the parts the device reports.
 * Built here so the version bytes are ours (plain xpub/tpub) and so the parts
 * can be checked against what the device claims the whole to be.
 */
export function encodeXpub(node: Message, network: NetworkName): string {
  const chainCode: Buffer | undefined = node.chain_code;
  const publicKey: Buffer | undefined = node.public_key;
  if (!chainCode || chainCode.length !== 32 || !publicKey || publicKey.length !== 33 || node.depth > 255) {
    throw new Error('The Trezor did not return a usable public key.');
  }
  const out = Buffer.alloc(78);
  out.writeUInt32BE(btcNetwork(network).bip32.public, 0);
  out.writeUInt8(node.depth, 4);
  out.writeUInt32BE(node.fingerprint >>> 0, 5);
  out.writeUInt32BE(node.child_num >>> 0, 9);
  Buffer.from(chainCode).copy(out, 13);
  Buffer.from(publicKey).copy(out, 45);
  const xpub = bs58check.encode(out);
  try {
    // Parsing it back proves the public key is a point on the curve.
    bip32.fromBase58(xpub, btcNetwork(network));
  } catch {
    throw new Error('The Trezor did not return a usable public key.');
  }
  return xpub;
}

/** Looks at what the device said about itself and refuses what cannot be worked with. */
export function checkFeatures(features: Message): DeviceInfo {
  const vendor: string = features.vendor ?? '';
  if (vendor !== 'trezor.io' && vendor !== 'bitcointrezor.com') {
    throw new Error(`This device says it is made by “${vendor || 'nobody'}”, not Trezor.`);
  }
  if (features.bootloader_mode) {
    throw new Error(
      'This Trezor is in bootloader mode, which is only for installing firmware. ' +
        'Unplug it and plug it back in without touching its screen or buttons.'
    );
  }
  if (features.firmware_present === false) {
    throw new Error('This Trezor has no firmware installed. Set it up in Trezor Suite first.');
  }
  const version = [features.major_version ?? 0, features.minor_version ?? 0, features.patch_version ?? 0];
  const firmware = version.join('.');
  const minimum = MIN_FIRMWARE[version[0] as 1 | 2];
  if (!minimum) throw new Error(`This Trezor runs firmware ${firmware}, which this app does not know.`);
  if (olderThan(version, minimum)) {
    throw new Error(
      `This Trezor runs firmware ${firmware}. Signing safely needs ${minimum.join('.')} or newer — update it in Trezor Suite.`
    );
  }
  if (!features.initialized) {
    throw new Error(
      'This Trezor has not been set up yet. Create or recover its wallet in Trezor Suite first, then connect it here.'
    );
  }
  return { model: modelName(features), firmware, label: features.label || undefined };
}

export class TrezorDevice implements HardwareDevice {
  readonly kind = 'trezor' as const;

  private session: TrezorSession;
  private info: DeviceInfo | null = null;
  private fingerprint: string | null = null;
  /** Commands run one at a time; this is the tail of the line. */
  private line: Promise<unknown> = Promise.resolve();
  private running = 0;
  private closed = false;

  constructor(
    private transport: PacketTransport,
    private options: DriverOptions
  ) {
    this.session = new TrezorSession(transport, options.prompts);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.line.then(async () => {
      if (this.closed) throw new Error('The connection to the Trezor is closed.');
      this.running++;
      try {
        return await task();
      } finally {
        this.running--;
      }
    });
    // The line carries on whether or not this command worked.
    this.line = next.catch(() => {});
    return next;
  }

  private ready(): void {
    if (!this.info) throw new Error('Connect to the Trezor first.');
  }

  connect(): Promise<DeviceInfo> {
    return this.run(async () => {
      const reply = await this.session.initialize();
      if (reply.type === MessageType.Failure) {
        if (reply.message.code === FailureType.InvalidProtocol) throw new Error(THP_ONLY_MESSAGE);
        throw new Error(`The Trezor would not start a session: ${reply.message.message ?? 'no reason given'}`);
      }
      if (reply.type !== MessageType.Features) {
        throw new Error('This device did not introduce itself the way a Trezor does.');
      }
      const info = checkFeatures(reply.message);
      this.session.capabilities = reply.message.capabilities ?? [];

      // Reading any key unlocks the device — PIN, then passphrase — so every
      // question the device has for its owner is asked here, once.
      if (reply.message.unlocked === false) this.options.prompts.status('Unlock your Trezor.');
      this.fingerprint = await this.readFingerprint();
      this.info = info;
      return info;
    });
  }

  /**
   * The master fingerprint, worked out here from the master public key rather
   * than taken from the field newer firmware reports — and compared with that
   * field when it is there.
   */
  private async readFingerprint(): Promise<string> {
    const master = await this.session.call(
      MessageType.GetPublicKey,
      GetPublicKey,
      { address_n: [], coin_name: 'Bitcoin', script_type: InputScriptType.SPENDADDRESS },
      MessageType.PublicKey
    );
    const pubkey: Buffer | undefined = master.node?.public_key;
    if (!pubkey || pubkey.length !== 33 || master.node.depth !== 0) {
      throw new Error('The Trezor did not return its master public key.');
    }
    const fingerprint = Buffer.from(bitcoin.crypto.hash160(pubkey).subarray(0, 4)).toString('hex');
    if (master.root_fingerprint !== undefined) {
      const reported = (master.root_fingerprint >>> 0).toString(16).padStart(8, '0');
      if (reported !== fingerprint) {
        throw new Error('The Trezor gave two different answers about which key it holds.');
      }
    }
    return fingerprint;
  }

  async masterFingerprint(): Promise<string> {
    this.ready();
    return this.fingerprint!;
  }

  /** Reads the public key at `steps`, for a caller already holding the line. */
  private async fetchKey(network: NetworkName, steps: number[]): Promise<string> {
    const reply = await this.session.call(
      MessageType.GetPublicKey,
      GetPublicKey,
      {
        address_n: steps,
        coin_name: network === 'mainnet' ? 'Bitcoin' : 'Testnet',
        // Plain xpub/tpub version bytes, whatever the path is for.
        script_type: InputScriptType.SPENDADDRESS,
      },
      MessageType.PublicKey
    );
    const node: Message | undefined = reply.node;
    if (!node) throw new Error('The Trezor did not return a usable public key.');
    // The key must be the one at the path that was asked for…
    if (node.depth !== steps.length || node.child_num >>> 0 !== steps[steps.length - 1]) {
      throw new Error('The Trezor returned a key for a different path from the one asked for.');
    }
    const xpub = encodeXpub(node, network);
    // …and the device's own encoding must describe that same key.
    let claimed;
    try {
      claimed = normaliseXpub(reply.xpub ?? '');
    } catch {
      throw new Error('The Trezor returned a public key that cannot be read.');
    }
    if (claimed.network !== network) throw new Error(`The Trezor returned a key that is not for ${network}.`);
    if (claimed.xpub !== xpub) {
      throw new Error('The Trezor returned a public key that does not match its own description of it.');
    }
    return xpub;
  }

  getKey(network: NetworkName, path: string = bip48Path(network)): Promise<HardwareKey> {
    return this.run(async () => {
      this.ready();
      const steps = parsePath(path);
      if (steps.length === 0) throw new Error('An account key needs a derivation path.');
      const xpub = await this.fetchKey(network, steps);
      return { xpub, fingerprint: this.fingerprint!, path: formatPath(steps), network };
    });
  }

  signMultisig(request: MultisigSignRequest): Promise<HardwareSignature[]> {
    return this.run(async () => {
      this.ready();
      // Everything that can be refused without the device is refused first.
      const plan = planSigning(request);

      const wanted = request.fingerprint.toLowerCase();
      if (wanted !== this.fingerprint) {
        throw new Error(
          `That is a different key. This Trezor holds ${this.fingerprint}, but this signature needs ${wanted}. ` +
            'Check it is the right device, with the right passphrase if it uses one.'
        );
      }
      // A fingerprint is four bytes anyone can copy. The account key is the proof.
      const cosigner = request.wallet.cosigners.find((c) => c.fingerprint.toLowerCase() === wanted)!;
      const held = await this.fetchKey(request.wallet.network, parsePath(cosigner.path));
      if (held !== normaliseXpub(cosigner.xpub).xpub) {
        throw new Error(
          `This Trezor's key at ${cosigner.path} is not the one in this wallet. ` +
            'Check it is the right device, with the right passphrase if it uses one.'
        );
      }

      this.options.prompts.status('Sending the transaction to the Trezor.');
      return runSigning(this.session, plan);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.running > 0) {
        // Something is waiting on the device — most likely on its owner.
        // Take the question off its screen; the waiting command hears the
        // device's refusal and ends as cancelled.
        await this.session.cancelInFlight();
        await Promise.race([this.line, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      } else if (this.info) {
        await this.session.endSession();
      }
    } finally {
      await this.transport.close();
    }
  }
}

export { TrezorFailure } from './session';

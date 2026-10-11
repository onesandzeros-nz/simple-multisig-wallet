import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { MultisigWallet, NetworkName } from '../types';

/**
 * Hardware wallets that sign over a USB cable. Everything in this folder is
 * transport-agnostic: a driver is handed something that moves 64-byte packets
 * and never learns whether that is a phone's USB port or a test double.
 */
export type HardwareKind = 'ledger' | 'trezor' | 'bitbox02';

/**
 * One packet at a time in each direction — what all three devices speak over
 * their interrupt endpoints. Message framing on top is the driver's business.
 */
export interface PacketTransport {
  /** Bytes per packet; 64 on every supported device. */
  readonly packetSize: number;
  /** Sends one packet. Shorter data is zero-padded to `packetSize` by the caller. */
  write(packet: Uint8Array): Promise<void>;
  /**
   * The next packet from the device. Rejects with a `TransportTimeout` when
   * nothing arrives within `timeoutMs`, and with any other error when the
   * device has gone (unplugged, closed).
   */
  read(timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Nothing arrived in time. The packet, if it comes later, is still delivered to the next read. */
export class TransportTimeout extends Error {
  constructor(message = 'The device did not answer in time.') {
    super(message);
    this.name = 'TransportTimeout';
  }
}

/** The user said no — on the device or on the phone. Never reported as a failure. */
export class UserCancelled extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'UserCancelled';
  }
}

/**
 * What a driver needs from the person holding the phone. A driver calls these
 * mid-command and waits; rejecting any of them with `UserCancelled` abandons
 * the command.
 */
export interface DevicePrompts {
  /** A line to show while the device is busy or waiting, e.g. "Confirm on your Ledger". */
  status(message: string): void;
  /**
   * Trezor Model One: the PIN is entered on the phone as positions on a blank
   * 3×3 keypad, read against the scrambled digits the device shows. Resolves
   * with the positions pressed, "1".."9" numbered like a phone's number pad
   * turned upside down (7 8 9 on the top row).
   */
  pinMatrix(): Promise<string>;
  /**
   * Trezor with a passphrase wallet switched on. Resolve with the passphrase,
   * or with null to type it on the device when `canEnterOnDevice`.
   */
  passphrase(canEnterOnDevice: boolean): Promise<string | null>;
  /**
   * BitBox02, first connection from this phone: the code to compare with the
   * one on the device. Resolves true once the user says the two match.
   */
  confirmPairing(code: string): Promise<boolean>;
}

/**
 * The little a driver must remember between connections: a Ledger's approval
 * of a wallet, the keys a BitBox02 pairing rests on. Kept in the device
 * keystore by the app and in a Map by tests.
 */
export interface DeviceMemory {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface DeviceInfo {
  /** What to call it on screen, e.g. "Ledger Nano S Plus", "Trezor Safe 3". */
  model: string;
  firmware?: string;
  /** The name its owner gave it, when the device has one. */
  label?: string;
}

/** An account key read off a device — the same shape every other import produces. */
export interface HardwareKey {
  /** Normalised to xpub (mainnet) / tpub (testnet). */
  xpub: string;
  /** Master fingerprint, 8 hex chars, lowercase. */
  fingerprint: string;
  /** e.g. m/48'/0'/0'/2' */
  path: string;
  network: NetworkName;
}

export interface MultisigSignRequest {
  wallet: MultisigWallet;
  /**
   * The transaction, with `witnessUtxo`, `witnessScript` and `bip32Derivation`
   * on every input and `nonWitnessUtxo` filled in — every device wants the
   * previous transactions to check the amounts it is shown.
   */
  psbt: bitcoin.Psbt;
  /** Master fingerprint of the cosigner this device signs as. */
  fingerprint: string;
}

export interface HardwareSignature {
  /** Input index in the PSBT. */
  index: number;
  /** The key that signed, 33 bytes compressed. */
  pubkey: Buffer;
  /** 64 bytes, r‖s. The sighash type is always SIGHASH_ALL. */
  signature: Buffer;
}

export interface HardwareDevice {
  readonly kind: HardwareKind;
  /**
   * Opens the session — handshake, pairing, unlock — and says what is on the
   * other end. Must be called once before anything else.
   */
  connect(): Promise<DeviceInfo>;
  /** Master fingerprint, 8 hex chars, lowercase. */
  masterFingerprint(): Promise<string>;
  /** The account key at `path`; the app's BIP48 P2WSH path when omitted. */
  getKey(network: NetworkName, path?: string): Promise<HardwareKey>;
  /**
   * Signs every input the device's key owns. The device shows the transaction
   * and the user approves it there; a wallet the device has not seen before is
   * shown for approval first where the device works that way.
   *
   * Signatures come back unverified — the caller checks each against the
   * sighash it computed itself before attaching it.
   */
  signMultisig(request: MultisigSignRequest): Promise<HardwareSignature[]>;
  close(): Promise<void>;
}

export interface DriverOptions {
  prompts: DevicePrompts;
  memory: DeviceMemory;
}

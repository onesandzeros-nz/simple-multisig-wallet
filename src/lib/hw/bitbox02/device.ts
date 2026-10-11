import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { bip32, bip48Path, btcNetwork } from '../../bitcoin';
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
  TransportTimeout,
  UserCancelled,
} from '../types';
import { hostCommitment, newHostNonce, verifyAntiklepto } from './antiklepto';
import { ATTESTATION_LENGTH, newChallenge, verifyAttestation } from './attestation';
import {
  decodeResponse,
  encodeRequest,
  ERR_DISABLED,
  ERR_DUPLICATE,
  ERR_GENERIC,
  ERR_INVALID_INPUT,
  ERR_USER_ABORT,
  RegisterXPubType,
  SignNextType,
  XPubType,
} from './messages';
import { CipherState, generateKeypair, keypairFromPrivate, NoiseInitiator, NoiseKeypair, pairingCode, PROTOCOL_NAME } from './noise';
import {
  coinFor,
  describeWallet,
  formatKeypath,
  isStandardMultisigPath,
  parseKeypath,
  planSigning,
  registrationName,
  SignPlan,
  WalletOnDevice,
  xpubIdentity,
} from './signing';
import { BOOTLOADER_CMD, FRAME_ERROR_INVALID_CMD, FrameError, HWW_CMD, readFrame, writeFrame } from './u2fhid';

/**
 * BitBox02 (and BitBox02 Nova) over its wallet channel.
 * Reference: github.com/BitBoxSwiss/bitbox02-api-go, api/firmware.
 *
 * Every message is a U2F-HID frame. Inside it, one status byte says whether
 * this is a new request or a poll for the answer to the last one — the device
 * never makes the phone wait on a person: while someone reads its screen it
 * answers "not ready" and is asked again. Inside that, after the handshake,
 * everything is encrypted with Noise and carries a protobuf Request/Response.
 */

// The request/response wrapper (firmware v7.0.0 onwards).
const REQ_NEW = 0x00;
const REQ_RETRY = 0x01;
const REQ_INFO = 0x69; // 'i'
const RSP_ACK = 0x00;
const RSP_NOT_READY = 0x01;
const RSP_BUSY = 0x02;
const RSP_NACK = 0x03;

// What a request is, one level in.
const OP_ATTESTATION = 0x61; // 'a'
const OP_UNLOCK = 0x75; // 'u'
const OP_HANDSHAKE_START = 0x68; // 'h'
const OP_HANDSHAKE_MESSAGE = 0x48; // 'H'
const OP_VERIFY_PAIRING = 0x76; // 'v'
const OP_NOISE_MESSAGE = 0x6e; // 'n'

const STATUS_SUCCESS = 0x00;
const STATUS_UNINITIALIZED = 0x02;

/**
 * The device answers every packet at once, even if only to say "not ready",
 * so a silence this long means it has gone rather than that someone is slow.
 */
export const READ_TIMEOUT_MS = 10_000;
/** Long enough for a packet already on its way to land, short enough not to be felt. */
const DRAIN_TIMEOUT_MS = 20;
const MAX_DRAINED_PACKETS = 256;
/** How often the device is asked whether the person has finished. */
const POLL_INTERVAL_MS = 200;
const BUSY_INTERVAL_MS = 1_000;
/** A device still busy with something else after this many tries is not coming back. */
const MAX_BUSY_TRIES = 30;

/** Anti-klepto signing arrived in 9.4.0; nothing older is asked to sign. */
const MIN_FIRMWARE: Version = [9, 4, 0];
/** A major version this code has never seen may speak differently. */
const UNKNOWN_FIRMWARE: Version = [10, 0, 0];

const MEMORY_STATIC_KEY = 'bitbox02.noise.key';
const MEMORY_PAIRED_DEVICES = 'bitbox02.noise.devices';
/** Every name this driver keeps in device memory, for the wipe to erase. */
export const BITBOX02_MEMORY_KEYS = [MEMORY_STATIC_KEY, MEMORY_PAIRED_DEVICES];
const MAX_REMEMBERED_DEVICES = 20;

type Version = [number, number, number];

function atLeast(version: Version, wanted: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== wanted[i]) return version[i] > wanted[i];
  }
  return true;
}

/** An error the device reported inside an encrypted response. */
export class BitBox02Error extends Error {
  constructor(
    readonly code: number,
    /** The firmware's own wording, for the log. */
    readonly deviceMessage: string,
    message: string
  ) {
    super(message);
    this.name = 'BitBox02Error';
  }
}

export interface BitBox02Info {
  version: Version;
  /** 0: BitBox02, 2: BitBox02 Nova. */
  platform: number;
  /** 0: Multi, 1: Bitcoin-only. */
  edition: number;
  unlocked: boolean;
  /** Reported by newer firmware only. */
  initialized?: boolean;
}

export interface BitBox02Options extends DriverOptions {
  /**
   * For the test suite and the simulator. The app never sets any of these:
   * each one switches off a check that protects a real device's owner.
   */
  testing?: {
    /** The simulator has no factory certificate, so it cannot pass attestation. */
    skipAttestation?: boolean;
    /** The simulator starts unseeded; the tests connect first and seed it over the channel. */
    allowUninitialized?: boolean;
    /** Root keys to accept instead of the manufacturer's. */
    attestationRoots?: readonly string[];
    sleep?: (ms: number) => Promise<void>;
  };
}

const MODELS: Record<number, Record<number, string>> = {
  0x00: { 0x00: 'BitBox02 Multi', 0x01: 'BitBox02 Bitcoin-only' },
  0x02: { 0x00: 'BitBox02 Nova Multi', 0x01: 'BitBox02 Nova Bitcoin-only' },
};

export function parseInfo(response: Uint8Array): BitBox02Info {
  const bytes = Buffer.from(response);
  const length = bytes[0];
  if (bytes.length < 1 || bytes.length < 1 + length + 3) {
    throw new Error('The BitBox02 did not say which firmware it runs.');
  }
  const text = bytes.toString('ascii', 1, 1 + length);
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) throw new Error(`The BitBox02 reported a firmware version this app cannot read (${text}).`);
  const rest = bytes.subarray(1 + length);
  if (rest[2] > 1) throw new Error('The BitBox02 sent an answer this app cannot read.');
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    platform: rest[0],
    edition: rest[1],
    unlocked: rest[2] === 1,
    initialized: rest.length > 3 ? rest[3] === 1 : undefined,
  };
}

export class BitBox02Device implements HardwareDevice {
  readonly kind = 'bitbox02' as const;

  private info: BitBox02Info | null = null;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private fingerprint: string | null = null;
  private closed = false;
  /** Commands run one at a time: the channel's two counters must move in step with the device's. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: PacketTransport,
    private readonly options: BitBox02Options
  ) {}

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.testing?.sleep) return this.options.testing.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private checkOpen(): void {
    if (this.closed) throw new UserCancelled();
  }

  /**
   * Throws away whatever is still waiting to be read. An answer that arrived
   * after its request was given up on would otherwise be taken for the answer
   * to the next one.
   */
  private async drain(): Promise<void> {
    for (let i = 0; i < MAX_DRAINED_PACKETS; i++) {
      try {
        await this.transport.read(DRAIN_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof TransportTimeout) return;
        throw e;
      }
    }
    throw new Error('The BitBox02 keeps sending data nobody asked for. Unplug it, plug it back in and try again.');
  }

  private async exchange(cmd: number, message: Uint8Array): Promise<Buffer> {
    this.checkOpen();
    await writeFrame(this.transport, cmd, message);
    return readFrame(this.transport, cmd, READ_TIMEOUT_MS);
  }

  /**
   * One request and its answer, however long a person takes over it. Returns
   * the payload that follows the device's ACK.
   */
  private async rawQuery(message: Uint8Array): Promise<Buffer> {
    const request = Buffer.concat([Buffer.from([REQ_NEW]), Buffer.from(message)]);
    let response = await this.exchange(HWW_CMD, request);
    // Busy means the request was dropped, not queued: send the same again.
    for (let tries = 0; response[0] === RSP_BUSY; tries++) {
      if (tries >= MAX_BUSY_TRIES) {
        throw new Error('The BitBox02 is busy with something else. Finish or cancel that on the device, then try again.');
      }
      await this.sleep(BUSY_INTERVAL_MS);
      response = await this.exchange(HWW_CMD, request);
    }
    for (;;) {
      if (response.length === 0) throw new Error('The BitBox02 sent an empty answer.');
      switch (response[0]) {
        case RSP_ACK:
          return Buffer.from(response.subarray(1));
        case RSP_NOT_READY:
          await this.sleep(POLL_INTERVAL_MS);
          response = await this.exchange(HWW_CMD, Buffer.from([REQ_RETRY]));
          break;
        case RSP_NACK:
        case RSP_BUSY:
        default:
          throw new Error('The BitBox02 lost track of the request. Unplug it, plug it back in and try again.');
      }
    }
  }

  /** One encrypted request. Throws a `BitBox02Error` when the device answers with an error. */
  private async query(request: Message): Promise<Message> {
    if (!this.send || !this.receive) throw new Error('Connect to the BitBox02 first.');
    const sealed = this.send.encrypt(encodeRequest(request));
    const answer = await this.rawQuery(Buffer.concat([Buffer.from([OP_NOISE_MESSAGE]), sealed]));
    if (answer.length < 1 || answer[0] !== STATUS_SUCCESS) {
      // The device could not decrypt it, or will not talk until paired again.
      throw new Error('The BitBox02 did not accept the message — the secure channel needs setting up again. Reconnect it and try again.');
    }
    const response = decodeResponse(this.receive.decrypt(answer.subarray(1)));
    if (response.error) {
      const code: number = response.error.code ?? 0;
      const text: string = response.error.message ?? '';
      console.warn(`[bitbox02] device error ${code}: ${text}`);
      if (code === ERR_USER_ABORT) throw new UserCancelled('Cancelled on the BitBox02.');
      throw new BitBox02Error(code, text, describeDeviceError(code, text));
    }
    return response;
  }

  private async queryBtc(request: Message): Promise<Message> {
    const response = await this.query({ btc: request });
    if (!response.btc) throw new Error('The BitBox02 sent an answer this app did not expect.');
    return response.btc;
  }

  /**
   * For the test suite: one request over the secure channel, outside the
   * commands this driver offers. Seeding the simulator needs it.
   */
  testingQuery(request: Message): Promise<Message> {
    return this.exclusive(() => this.query(request));
  }

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  private async readInfo(): Promise<BitBox02Info> {
    try {
      // Not wrapped like other requests, so that it works whatever the firmware.
      return parseInfo(await this.exchange(HWW_CMD, Buffer.from([REQ_INFO])));
    } catch (e) {
      if (!(e instanceof FrameError) || e.code !== FRAME_ERROR_INVALID_CMD) throw e;
    }
    // Nothing answers the wallet command. If the bootloader's does, that is
    // what is running.
    let bootloader = false;
    try {
      await this.exchange(BOOTLOADER_CMD, Buffer.from('v', 'ascii'));
      bootloader = true;
    } catch {
      bootloader = false;
    }
    throw new Error(
      bootloader
        ? 'The BitBox02 is in bootloader mode, waiting for a firmware update. Unplug it and plug it back in without touching it, or finish the update in the BitBoxApp.'
        : 'This device did not answer like a BitBox02.'
    );
  }

  private async attest(): Promise<void> {
    if (this.options.testing?.skipAttestation) return;
    const refusal =
      'This device could not prove it is a genuine BitBox02, so it was not used. Check it with the BitBoxApp; if that warns you too, contact the manufacturer.';
    const challenge = newChallenge();
    const response = await this.rawQuery(Buffer.concat([Buffer.from([OP_ATTESTATION]), challenge]));
    if (response.length < 1 + ATTESTATION_LENGTH || response[0] !== STATUS_SUCCESS) {
      console.warn('[bitbox02] attestation: the device returned no certificate');
      throw new Error(refusal);
    }
    try {
      verifyAttestation(
        challenge,
        response.subarray(1, 1 + ATTESTATION_LENGTH),
        this.options.testing?.attestationRoots
      );
    } catch (e: any) {
      console.warn(`[bitbox02] attestation: ${e?.message ?? e}`);
      throw new Error(refusal);
    }
  }

  private async staticKey(): Promise<NoiseKeypair> {
    const stored = await this.options.memory.get(MEMORY_STATIC_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return keypairFromPrivate(Buffer.from(stored, 'hex'));
    const fresh = generateKeypair();
    try {
      await this.options.memory.set(MEMORY_STATIC_KEY, fresh.privateKey.toString('hex'));
    } catch (e: any) {
      // The connection works without it; the device will just ask to pair again next time.
      console.warn(`[bitbox02] could not store this phone's pairing key: ${e?.message ?? e}`);
    }
    return fresh;
  }

  private async pairedDevices(): Promise<string[]> {
    try {
      const parsed = JSON.parse((await this.options.memory.get(MEMORY_PAIRED_DEVICES)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d)) : [];
    } catch {
      return [];
    }
  }

  private async handshakeQuery(message: Uint8Array): Promise<Buffer> {
    const response = await this.rawQuery(Buffer.concat([Buffer.from([OP_HANDSHAKE_MESSAGE]), Buffer.from(message)]));
    if (response.length < 1 || response[0] !== STATUS_SUCCESS) {
      throw new Error('The BitBox02 refused the secure-channel handshake. Unplug it, plug it back in and try again.');
    }
    return Buffer.from(response.subarray(1));
  }

  private async pair(): Promise<void> {
    const { prompts, memory } = this.options;
    const noise = new NoiseInitiator(await this.staticKey(), Buffer.from(PROTOCOL_NAME, 'ascii'));

    const started = await this.rawQuery(Buffer.from([OP_HANDSHAKE_START]));
    if (started.length !== 1 || started[0] !== STATUS_SUCCESS) {
      throw new Error('The BitBox02 refused to start a secure channel. Unplug it, plug it back in and try again.');
    }
    noise.readSecond(await this.handshakeQuery(noise.writeFirst()));
    const channel = noise.writeThird();
    const verdict = await this.handshakeQuery(channel.message);

    const device = channel.remoteStatic.toString('hex');
    const known = await this.pairedDevices();
    // Either side may insist: the device when it has not seen this phone, the
    // phone when it has not seen this device. Trusting only the device's word
    // would let an impostor in the middle simply say "no need".
    const deviceAsks = verdict.length === 1 && verdict[0] === 0x01;
    if (deviceAsks || !known.includes(device)) {
      const code = pairingCode(channel.handshakeHash);
      prompts.status('Check that the pairing code on the BitBox02 matches the one shown here, then confirm it on both.');

      type Answer = { from: 'phone' | 'device'; ok: boolean };
      const onPhone: Promise<Answer> = prompts.confirmPairing(code).then((ok) => ({ from: 'phone', ok }));
      const onDevice: Promise<Answer> = this.rawQuery(Buffer.from([OP_VERIFY_PAIRING])).then((r) => ({
        from: 'device',
        ok: r.length === 1 && r[0] === STATUS_SUCCESS,
      }));
      // Whichever loses the race below may still fail later; that failure is
      // reported through the one that is awaited, not as a stray rejection.
      onPhone.catch(() => {});
      onDevice.catch(() => {});

      let first: Answer;
      try {
        first = await Promise.race([onPhone, onDevice]);
      } catch (e) {
        this.closed = true; // stops the polling still running for the device
        throw e;
      }
      if (!first.ok) {
        this.closed = true;
        throw new UserCancelled(
          first.from === 'device'
            ? 'The pairing code was rejected on the BitBox02.'
            : 'The pairing codes did not match, so the BitBox02 was not used. Unplug it and try again; if they never match, something is interfering with the connection.'
        );
      }
      let second: Answer;
      try {
        second = await (first.from === 'phone' ? onDevice : onPhone);
      } catch (e) {
        this.closed = true;
        throw e;
      }
      if (!second.ok) {
        this.closed = true;
        throw new UserCancelled(
          second.from === 'device'
            ? 'The pairing code was rejected on the BitBox02.'
            : 'The pairing codes did not match, so the BitBox02 was not used. Unplug it and try again; if they never match, something is interfering with the connection.'
        );
      }
      const remembered = [device, ...known.filter((d) => d !== device)].slice(0, MAX_REMEMBERED_DEVICES);
      try {
        await memory.set(MEMORY_PAIRED_DEVICES, JSON.stringify(remembered));
      } catch (e: any) {
        console.warn(`[bitbox02] could not remember the paired device: ${e?.message ?? e}`);
      }
    }
    this.send = channel.send;
    this.receive = channel.receive;
  }

  connect(): Promise<DeviceInfo> {
    return this.exclusive(async () => {
      const { prompts, testing } = this.options;
      this.send = null;
      this.receive = null;
      this.fingerprint = null;

      this.checkOpen();
      await this.drain();
      const info = await this.readInfo();
      this.info = info;
      const version = info.version.join('.');
      if (!atLeast(info.version, MIN_FIRMWARE)) {
        throw new Error(
          `This BitBox02 runs firmware ${version}. Update it to ${MIN_FIRMWARE.join('.')} or newer in the BitBoxApp, then try again.`
        );
      }
      if (atLeast(info.version, UNKNOWN_FIRMWARE)) {
        throw new Error(`This BitBox02 runs firmware ${version}, which is newer than this app knows how to talk to. Update the app.`);
      }
      const model = MODELS[info.platform]?.[info.edition];
      if (!model) throw new Error('This is a BitBox model this app does not know.');
      const notSetUp = 'This BitBox02 has not been set up yet. Set it up with the BitBoxApp first, then connect it here.';
      if (info.initialized === false && !testing?.allowUninitialized) throw new Error(notSetUp);

      await this.attest();

      if (!info.unlocked && info.initialized !== false) {
        prompts.status('Enter your password on the BitBox02 to unlock it.');
      }
      const unlocked = await this.rawQuery(Buffer.from([OP_UNLOCK]));
      if (unlocked[0] === STATUS_UNINITIALIZED && !testing?.allowUninitialized) throw new Error(notSetUp);

      await this.pair();

      const details = (await this.query({ device_info: {} })).device_info;
      if (!details) throw new Error('The BitBox02 sent an answer this app did not expect.');
      if (!details.initialized && !testing?.allowUninitialized) throw new Error(notSetUp);
      return { model, firmware: version, label: details.name || undefined };
    });
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private async readFingerprint(): Promise<string> {
    if (this.fingerprint) return this.fingerprint;
    const response = await this.query({ fingerprint: {} });
    const bytes: Buffer | undefined = response.fingerprint?.fingerprint;
    if (!bytes || bytes.length !== 4) throw new Error('The BitBox02 did not return its key fingerprint.');
    this.fingerprint = Buffer.from(bytes).toString('hex');
    return this.fingerprint;
  }

  masterFingerprint(): Promise<string> {
    return this.exclusive(() => this.readFingerprint());
  }

  private async readXpub(network: NetworkName, keypath: number[]): Promise<string> {
    if (!isStandardMultisigPath(keypath, network)) {
      this.options.prompts.status(
        `The BitBox02 will warn that ${formatKeypath(keypath)} is an unusual key path. Confirm on the device to continue.`
      );
    }
    let response: Message;
    try {
      response = await this.query({
        btc_pub: {
          coin: coinFor(network),
          keypath,
          xpub_type: network === 'mainnet' ? XPubType.XPUB : XPubType.TPUB,
          display: false,
        },
      });
    } catch (e) {
      if (e instanceof BitBox02Error && e.code === ERR_INVALID_INPUT) {
        throw new Error(`The BitBox02 would not give out the key at ${formatKeypath(keypath)}.`);
      }
      throw e;
    }
    const xpub: string | undefined = response.pub?.pub;
    if (!xpub) throw new Error('The BitBox02 did not return a key.');
    // The device's word for what it sent is checked, not assumed: the key
    // must parse for this network and sit where it was asked for.
    let node;
    try {
      node = bip32.fromBase58(xpub, btcNetwork(network));
    } catch {
      throw new Error('The BitBox02 returned a key this app cannot read.');
    }
    if (!node.isNeutered()) throw new Error('The BitBox02 returned a private key, which is never imported.');
    if (node.depth !== keypath.length || node.index !== keypath[keypath.length - 1]) {
      throw new Error('The BitBox02 returned a key from a different path than the one asked for.');
    }
    return xpub;
  }

  getKey(network: NetworkName, path?: string): Promise<HardwareKey> {
    return this.exclusive(async () => {
      const keypath = parseKeypath(path ?? bip48Path(network));
      if (keypath.length === 0) throw new Error('A key path is needed to read an account key.');
      const fingerprint = await this.readFingerprint();
      const xpub = await this.readXpub(network, keypath);
      return { xpub, fingerprint, path: formatKeypath(keypath), network };
    });
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  private async ensureRegistered(request: MultisigSignRequest, onDevice: WalletOnDevice): Promise<void> {
    const registration = {
      coin: onDevice.coin,
      script_config: onDevice.scriptConfig,
      keypath: onDevice.accountKeypath,
    };
    let answer: Message;
    try {
      answer = await this.queryBtc({ is_script_config_registered: { registration } });
    } catch (e) {
      if (e instanceof BitBox02Error && e.code === ERR_INVALID_INPUT) {
        throw new Error('The BitBox02 does not accept this wallet. Check that every cosigner key was imported correctly.');
      }
      throw e;
    }
    if (answer.is_script_config_registered?.is_registered) return;

    const { prompts } = this.options;
    const register = async (name: string) => {
      const response = await this.queryBtc({
        register_script_config: { registration, name, xpub_type: RegisterXPubType.AUTO_XPUB_TPUB },
      });
      if (!response.success) throw new Error('The BitBox02 did not confirm that it stored the wallet.');
    };
    const name = registrationName(request.wallet);
    prompts.status(
      `The BitBox02 has not seen this wallet before. Check the name “${name}” and every cosigner key on its screen against the wallet’s details, and confirm each one.`
    );
    try {
      await register(name);
    } catch (e) {
      if (e instanceof BitBox02Error && e.code === ERR_DUPLICATE) {
        // Another wallet already goes by this name on the device, which only
        // comes to light after everything has been confirmed. Once more, under
        // a name that cannot clash.
        const distinct = registrationName(request.wallet, true);
        prompts.status(
          `The BitBox02 already has a different wallet called “${name}”. Confirm the details once more to store this one as “${distinct}”.`
        );
        await register(distinct);
      } else if (e instanceof BitBox02Error && e.code === ERR_GENERIC) {
        throw new Error('The BitBox02 could not store this wallet. It may have no room left for another multisig wallet.');
      } else if (e instanceof BitBox02Error && e.code === ERR_INVALID_INPUT) {
        throw new Error('The BitBox02 does not accept this wallet. Check that every cosigner key was imported correctly.');
      } else {
        throw e;
      }
    }
  }

  /** Walks the device through the transaction, answering whatever it asks for next. */
  private async runSigning(plan: SignPlan): Promise<Buffer[]> {
    const signatures: (Buffer | null)[] = plan.inputs.map(() => null);
    const signNext = (response: Message): Message => {
      const next = response.btc_sign_next ?? response.btc?.sign_next;
      if (!next) throw new Error('The BitBox02 sent an answer this app did not expect.');
      return next;
    };
    // The device goes through the inputs twice: once to learn what is being
    // spent, and again, after the person has agreed, to sign.
    let signing = false;
    let next = signNext(await this.query({ btc_sign_init: plan.init }));

    // Each answer names one step, and there are only so many: two passes over
    // the inputs, every previous transaction's parts, the outputs.
    let budget =
      4 +
      plan.outputs.length +
      plan.inputs.reduce((sum, i) => sum + 4 + i.prevTx.inputs.length + i.prevTx.outputs.length, 0);

    for (;;) {
      if (budget-- <= 0) throw new Error('The BitBox02 kept asking for more than this transaction contains.');
      const type: number = next.type ?? SignNextType.INPUT;
      const index: number = next.index ?? 0;
      const prevIndex: number = next.prev_index ?? 0;
      if (type === SignNextType.DONE) break;
      if (type === SignNextType.OUTPUT) {
        const output = plan.outputs[index];
        if (!output) throw new Error('The BitBox02 asked for an output this transaction does not have.');
        next = signNext(await this.query({ btc_sign_output: output }));
        continue;
      }
      const input = plan.inputs[index];
      if (!input) throw new Error('The BitBox02 asked for an input this transaction does not have.');

      if (type === SignNextType.PREVTX_INIT) {
        next = signNext(await this.query({ btc: { prevtx_init: input.prevTx.init } }));
      } else if (type === SignNextType.PREVTX_INPUT) {
        const part = input.prevTx.inputs[prevIndex];
        if (!part) throw new Error('The BitBox02 asked for part of a previous transaction that is not there.');
        next = signNext(await this.query({ btc: { prevtx_input: part } }));
      } else if (type === SignNextType.PREVTX_OUTPUT) {
        const part = input.prevTx.outputs[prevIndex];
        if (!part) throw new Error('The BitBox02 asked for part of a previous transaction that is not there.');
        next = signNext(await this.query({ btc: { prevtx_output: part } }));
      } else if (type === SignNextType.INPUT) {
        if (!signing) {
          next = signNext(await this.query({ btc_sign_input: input.request }));
        } else {
          // The device commits to its nonce before it learns ours, and must
          // then sign with the two combined (see antiklepto.ts).
          const hostNonce = newHostNonce();
          const committed = signNext(
            await this.query({
              btc_sign_input: { ...input.request, host_nonce_commitment: { commitment: hostCommitment(hostNonce) } },
            })
          );
          const commitment: Buffer | undefined = committed.anti_klepto_signer_commitment?.commitment;
          if (committed.type !== SignNextType.HOST_NONCE || !commitment) {
            throw new Error('The BitBox02 skipped a step that protects its key, so its signature was not accepted.');
          }
          next = signNext(await this.query({ btc: { antiklepto_signature: { host_nonce: hostNonce } } }));
          const signature: Buffer | undefined = next.signature;
          if (!next.has_signature || !signature) throw new Error('The BitBox02 did not return a signature.');
          verifyAntiklepto(hostNonce, commitment, signature);
          signatures[index] = Buffer.from(signature);
        }
        if (index === plan.inputs.length - 1) signing = true;
      } else {
        throw new Error('The BitBox02 asked for something this app does not know how to give.');
      }
    }

    return signatures.map((signature, i) => {
      if (!signature) throw new Error(`The BitBox02 finished without signing input ${i + 1}.`);
      return signature;
    });
  }

  signMultisig(request: MultisigSignRequest): Promise<HardwareSignature[]> {
    return this.exclusive(async () => {
      const { prompts } = this.options;
      if (!this.info) throw new Error('Connect to the BitBox02 first.');
      const wanted = request.fingerprint.toLowerCase();
      const actual = await this.readFingerprint();
      if (actual !== wanted) {
        throw new Error(
          `That is a different device, or a different passphrase. It holds key ${actual}, but this signature needs ${wanted}.`
        );
      }

      const onDevice = describeWallet(request.wallet, wanted);
      // A fingerprint is four bytes anyone can copy. The key itself has to match.
      const held = await this.readXpub(request.wallet.network, onDevice.accountKeypath);
      if (!xpubIdentity(held).equals(xpubIdentity(onDevice.cosigner.xpub))) {
        throw new Error(
          `This BitBox02 holds a different key at ${formatKeypath(onDevice.accountKeypath)} from the one in this wallet, so it cannot sign for it.`
        );
      }

      const plan = planSigning(request, {
        ownReceiveOutputs: atLeast(this.info.version, [9, 15, 0]),
        opReturnOutputs: atLeast(this.info.version, [9, 24, 0]),
      });

      await this.ensureRegistered(request, onDevice);

      prompts.status('Check the transaction on the BitBox02 — every address and amount, then the fee — and confirm it there.');
      let signatures: Buffer[];
      try {
        signatures = await this.runSigning(plan);
      } catch (e) {
        if (e instanceof BitBox02Error && e.code === ERR_INVALID_INPUT) {
          throw new Error('The BitBox02 refused this transaction. It may contain something the device does not support.');
        }
        throw e;
      }

      return plan.inputs.map((input, index) => {
        // Checked here as well as by the caller: a signature over anything but
        // this transaction, by this key, never leaves the driver.
        if (!ecc.verify(input.sighash, input.pubkey, signatures[index])) {
          throw new Error(`The BitBox02 returned a signature for input ${index + 1} that does not match this transaction.`);
        }
        return { index, pubkey: input.pubkey, signature: signatures[index] };
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.send = null;
    this.receive = null;
    await this.transport.close();
  }
}

function describeDeviceError(code: number, text: string): string {
  switch (code) {
    case ERR_INVALID_INPUT:
      return 'The BitBox02 did not accept the request.';
    case ERR_DISABLED:
      return 'This BitBox02 has that feature switched off.';
    case ERR_DUPLICATE:
      return 'The BitBox02 already has an entry with that name.';
    default:
      return `The BitBox02 reported an error: ${text || 'no details given'} (code ${code}).`;
  }
}

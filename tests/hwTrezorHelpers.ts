import dgram from 'node:dgram';
import { Buffer } from 'buffer';
import { decodeMessage, encodeMessage, Message, MessageSchema } from '../src/lib/hw/protobuf';
import { DevicePrompts, PacketTransport, TransportTimeout, UserCancelled } from '../src/lib/hw/types';
import { readMessage, writeMessage } from '../src/lib/hw/trezor/codec';
import { ButtonRequest, Failure, Features, HDNodeType, MessageType } from '../src/lib/hw/trezor/messages';

/**
 * Test-only plumbing for reaching the official Trezor emulators: a packet
 * transport over UDP, and the emulator's debug link, which stands in for the
 * person pressing buttons.
 */

// ---------------------------------------------------------------------------
// Messages only a test sends
// ---------------------------------------------------------------------------

export const TestMessageType = {
  WipeDevice: 5,
  LoadDevice: 13,
  LockDevice: 24,
  ApplySettings: 25,
  GetFeatures: 55,
  DebugLinkDecision: 100,
  DebugLinkGetState: 101,
  DebugLinkState: 102,
} as const;

const LoadDevice: MessageSchema = {
  mnemonics: { id: 1, type: 'string', repeated: true },
  pin: { id: 3, type: 'string' },
  passphrase_protection: { id: 4, type: 'bool' },
  label: { id: 6, type: 'string' },
  skip_checksum: { id: 7, type: 'bool' },
};

const ApplySettings: MessageSchema = {
  use_passphrase: { id: 3, type: 'bool' },
  passphrase_always_on_device: { id: 8, type: 'bool' },
};

const DebugLinkDecision: MessageSchema = {
  /** `yes_no` on old firmware, `button` (NO=0, YES=1) on new: the same byte on the wire. */
  button: { id: 1, type: 'enum' },
  swipe: { id: 2, type: 'enum' },
  input: { id: 3, type: 'string' },
};

const DebugLinkGetState: MessageSchema = {
  wait_layout: { id: 3, type: 'enum' },
};

const DebugLinkState: MessageSchema = {
  pin: { id: 2, type: 'string' },
  matrix: { id: 3, type: 'string' },
  node: { id: 5, type: HDNodeType },
  tokens: { id: 13, type: 'string', repeated: true },
};

// ---------------------------------------------------------------------------
// UDP transport
// ---------------------------------------------------------------------------

export class UdpTransport implements PacketTransport {
  readonly packetSize = 64;
  private socket: dgram.Socket;
  private inbox: Buffer[] = [];
  private waiter: ((packet: Buffer | Error) => void) | null = null;
  private closed = false;
  /** Every packet, in order, for tests that want to look at the conversation. */
  onPacket: ((direction: 'out' | 'in', packet: Buffer) => void) | null = null;

  private constructor(socket: dgram.Socket) {
    this.socket = socket;
    socket.on('message', (packet) => {
      // The emulator answers a liveness probe on the same socket; it is not protocol.
      if (packet.length === 8 && packet.toString('ascii') === 'PONGPONG') {
        this.pong?.();
        return;
      }
      this.onPacket?.('in', packet);
      if (this.waiter) {
        const deliver = this.waiter;
        this.waiter = null;
        deliver(packet);
      } else {
        this.inbox.push(packet);
      }
    });
    // A refused datagram surfaces here; reads time out on their own.
    socket.on('error', () => {});
  }

  private pong: (() => void) | null = null;

  static async open(host: string, port: number): Promise<UdpTransport> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, host, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    return new UdpTransport(socket);
  }

  /** True once the emulator answers; false if it has not within `timeoutMs`. */
  async ping(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const answered = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.pong = null;
          resolve(false);
        }, 150);
        this.pong = () => {
          clearTimeout(timer);
          this.pong = null;
          resolve(true);
        };
        this.socket.send(Buffer.from('PINGPING', 'ascii'), () => {});
      });
      if (answered) return true;
    }
    return false;
  }

  async write(packet: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('The transport is closed.');
    if (packet.length !== this.packetSize) throw new Error(`A packet must be ${this.packetSize} bytes.`);
    this.onPacket?.('out', Buffer.from(packet));
    await new Promise<void>((resolve, reject) =>
      this.socket.send(packet, (error) => (error ? reject(error) : resolve()))
    );
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('The transport is closed.'));
    const ready = this.inbox.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new TransportTimeout());
      }, timeoutMs);
      this.waiter = (packet) => {
        clearTimeout(timer);
        if (packet instanceof Error) reject(packet);
        else resolve(packet);
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waiter?.(new Error('The transport was closed.'));
    this.waiter = null;
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// The emulator's debug link: the hands of the person who is not there
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DebugLink {
  private constructor(private transport: UdpTransport) {}

  static async open(host: string, port: number): Promise<DebugLink> {
    return new DebugLink(await UdpTransport.open(host, port));
  }

  private send(type: number, schema: MessageSchema, message: Message): Promise<void> {
    return writeMessage(this.transport, type, encodeMessage(schema, message));
  }

  pressYes(): Promise<void> {
    return this.send(TestMessageType.DebugLinkDecision, DebugLinkDecision, { button: 1 });
  }

  pressNo(): Promise<void> {
    return this.send(TestMessageType.DebugLinkDecision, DebugLinkDecision, { button: 0 });
  }

  swipeUp(): Promise<void> {
    return this.send(TestMessageType.DebugLinkDecision, DebugLinkDecision, { swipe: 0 });
  }

  /** Types on the device's own keyboard: a PIN or a passphrase. */
  input(text: string): Promise<void> {
    return this.send(TestMessageType.DebugLinkDecision, DebugLinkDecision, { input: text });
  }

  async state(waitLayout?: number): Promise<Message> {
    await this.send(
      TestMessageType.DebugLinkGetState,
      DebugLinkGetState,
      waitLayout === undefined ? {} : { wait_layout: waitLayout }
    );
    const reply = await readMessage(this.transport, 10_000);
    if (reply.type !== TestMessageType.DebugLinkState) {
      throw new Error(`Debug link answered with message ${reply.type}.`);
    }
    return decodeMessage(DebugLinkState, reply.data);
  }

  /** Model One: where each digit of `pin` sits on the scrambled keypad it is showing. */
  async encodePin(pin: string): Promise<string> {
    const { matrix } = await this.state();
    if (!matrix) throw new Error('The emulator is not showing a PIN keypad.');
    return [...pin].map((digit) => String(matrix.indexOf(digit) + 1)).join('');
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

// ---------------------------------------------------------------------------
// An emulator with someone at the controls
// ---------------------------------------------------------------------------

export interface EmulatorOptions {
  host: string;
  port: number;
}

export interface LoadOptions {
  mnemonic: string;
  pin?: string;
  passphraseProtection?: boolean;
  label?: string;
}

/** What the person at the device does when it asks for a confirmation. */
export type ButtonPolicy = 'confirm' | 'reject' | 'ignore';

export class Emulator {
  /** Status lines the driver showed, in order. */
  statuses: string[] = [];
  /** ButtonRequest codes the device raised, in order. */
  buttons: number[] = [];
  policy: ButtonPolicy = 'confirm';
  pin = '';
  /** What is typed when the device asks for the passphrase on its own screen. */
  devicePassphrase = '';
  /** What the phone answers when asked for a passphrase; null means "on the device". */
  hostPassphrase: string | null = '';
  /** Set to make the phone's PIN or passphrase prompt be cancelled. */
  cancelPrompts = false;
  pinPrompts = 0;
  passphrasePrompts = 0;
  features: Message = {};

  private lastButton: Message | null = null;
  private pending: Promise<void> = Promise.resolve();
  private opened: UdpTransport[] = [];

  private constructor(
    private options: EmulatorOptions,
    /** Used for setting the emulator up; drivers get a transport of their own. */
    private admin: UdpTransport,
    readonly debug: DebugLink
  ) {
    this.watch(admin);
  }

  /**
   * Watches a conversation the way someone watching the screen would: when
   * the device asks for a button and the host has agreed to wait, press it.
   */
  private watch(transport: UdpTransport): void {
    transport.onPacket = (direction, packet) => {
      if (packet[0] !== 0x3f || packet[1] !== 0x23 || packet[2] !== 0x23) return;
      const type = packet.readUInt16BE(3);
      const length = packet.readUInt32BE(5);
      if (direction === 'in' && type === MessageType.ButtonRequest) {
        this.lastButton = decodeMessage(ButtonRequest, packet.subarray(9, 9 + length));
        this.buttons.push(this.lastButton.code);
      }
      if (direction === 'out' && type === MessageType.ButtonAck && this.lastButton) {
        const request = this.lastButton;
        // Decided now, as the question appears — not by whatever the test wants later.
        const policy = this.policy;
        this.lastButton = null;
        this.pending = this.pending.then(() => this.act(request, policy)).catch(() => {});
      }
    };
  }

  static async open(options: EmulatorOptions): Promise<Emulator> {
    const admin = await UdpTransport.open(options.host, options.port);
    if (!(await admin.ping(10_000))) {
      await admin.close();
      throw new Error(`No Trezor emulator is answering on ${options.host}:${options.port}.`);
    }
    const debug = await DebugLink.open(options.host, options.port + 1);
    return new Emulator(options, admin, debug);
  }

  /** A fresh connection for a driver, which will close it when it is done. */
  async transport(): Promise<UdpTransport> {
    const transport = await UdpTransport.open(this.options.host, this.options.port);
    this.watch(transport);
    this.opened.push(transport);
    return transport;
  }

  get isModelOne(): boolean {
    return this.features.major_version === 1;
  }

  private async act(request: Message, policy: ButtonPolicy): Promise<void> {
    if (policy === 'ignore') return;
    // Give the screen a moment to come up, as a person would.
    await sleep(150);
    if (request.code === 20) return this.debug.input(this.pin);
    if (request.code === 19) return this.debug.input(this.devicePassphrase);
    if (policy === 'reject') return this.debug.pressNo();
    for (let page = 1; page < (request.pages ?? 1); page++) {
      await this.debug.swipeUp();
      await sleep(100);
    }
    await this.confirmCurrentScreen();
  }

  /**
   * Agrees to the question on the screen. On the newest models one question
   * can run over several screens, swiped through before the last is agreed
   * to — and anything pressed after the question is settled would be left
   * over for the next one to trip on, so each step looks before it presses.
   */
  private async confirmCurrentScreen(): Promise<void> {
    const model: string = this.features.internal_model ?? '';
    if (model !== 'T3T1' && model !== 'T3W1') return this.debug.pressYes();
    const asked = this.buttons.length;
    for (let screen = 0; screen < 12; screen++) {
      const layout = ((await this.debug.state(2)).tokens ?? []).join('');
      const swipes = /SwipeContent/.test(layout) && !/PromptScreen/.test(layout);
      if (screen > 0) {
        // The device has moved on to its next question, or to no question at all.
        if (this.buttons.length !== asked) return;
        if (!swipes && !/PromptScreen/.test(layout)) return;
      }
      if (!swipes) return this.debug.pressYes();
      await this.debug.swipeUp();
      await sleep(200);
    }
  }

  readonly prompts: DevicePrompts = {
    status: (message) => {
      this.statuses.push(message);
    },
    pinMatrix: async () => {
      this.pinPrompts++;
      if (this.cancelPrompts) throw new UserCancelled();
      return this.debug.encodePin(this.pin);
    },
    passphrase: async () => {
      this.passphrasePrompts++;
      if (this.cancelPrompts) throw new UserCancelled();
      return this.hostPassphrase;
    },
    confirmPairing: async () => true,
  };

  /** A raw request on the main link, with buttons pressed, for setting the emulator up. */
  private async setupCall(type: number, schema: MessageSchema, message: Message): Promise<void> {
    await writeMessage(this.admin, type, encodeMessage(schema, message));
    for (;;) {
      const reply = await readMessage(this.admin, 30_000);
      if (reply.type === MessageType.ButtonRequest) {
        await writeMessage(this.admin, MessageType.ButtonAck, Buffer.alloc(0));
        continue;
      }
      if (reply.type === MessageType.Failure) {
        const failure = decodeMessage(Failure, reply.data);
        throw new Error(`Emulator setup failed: ${failure.message} (code ${failure.code})`);
      }
      if (reply.type === MessageType.Success) break;
      throw new Error(`Emulator setup got unexpected message ${reply.type}.`);
    }
    await this.pending;
  }

  async readFeatures(): Promise<Message> {
    await writeMessage(this.admin, MessageType.Initialize, Buffer.alloc(0));
    // Initialize interrupts whatever a failed test left running, whose last
    // words may arrive first.
    for (let i = 0; i < 8; i++) {
      const reply = await readMessage(this.admin, 10_000);
      if (reply.type !== MessageType.Features) continue;
      this.features = decodeMessage(Features, reply.data);
      return this.features;
    }
    throw new Error('The emulator never answered Initialize with Features.');
  }

  /** Wipes the emulator and loads a seed, so every test starts from a known device. */
  async load(options: LoadOptions): Promise<void> {
    const before = this.policy;
    this.policy = 'confirm';
    await this.readFeatures();
    if (this.features.initialized) {
      await this.setupCall(TestMessageType.WipeDevice, {}, {});
      await this.readFeatures();
    }
    await this.setupCall(TestMessageType.LoadDevice, LoadDevice, {
      mnemonics: [options.mnemonic],
      pin: options.pin ?? '',
      passphrase_protection: options.passphraseProtection ?? false,
      label: options.label ?? 'test',
    });
    await this.readFeatures();
    this.pin = options.pin ?? '';
    this.hostPassphrase = '';
    this.devicePassphrase = '';
    this.reset();
    this.policy = before;
  }

  /** Locks the device, as its own timer would, so the PIN is wanted again. */
  async lock(): Promise<void> {
    await this.setupCall(TestMessageType.LockDevice, {}, {});
    this.reset();
  }

  async applySettings(settings: { passphraseAlwaysOnDevice?: boolean }): Promise<void> {
    await this.setupCall(TestMessageType.ApplySettings, ApplySettings, {
      passphrase_always_on_device: settings.passphraseAlwaysOnDevice,
    });
    this.reset();
  }

  /** Forgets what earlier steps recorded, and puts the person at the controls back to normal. */
  reset(): void {
    this.policy = 'confirm';
    this.cancelPrompts = false;
    this.statuses = [];
    this.buttons = [];
    this.pinPrompts = 0;
    this.passphrasePrompts = 0;
  }

  /** Waits for any button press still on its way to the device. */
  settled(): Promise<void> {
    return this.pending;
  }

  async close(): Promise<void> {
    await this.pending;
    // A test that failed half way may have left its connection open.
    for (const transport of this.opened) await transport.close();
    await this.debug.close();
    await this.admin.close();
  }
}

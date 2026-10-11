import { Buffer } from 'buffer';
import { decodeMessage, encodeMessage, Message, MessageSchema } from '../protobuf';
import { DevicePrompts, PacketTransport, TransportTimeout, UserCancelled } from '../types';
import { readMessage, writeMessage } from './codec';
import {
  ButtonRequestType,
  CAPABILITY_PASSPHRASE_ENTRY,
  Empty,
  FailureType,
  INCOMING,
  Initialize,
  messageName,
  MessageType,
  PassphraseAck,
  PinMatrixAck,
} from './messages';

/**
 * The conversation with a Trezor: one request, then whatever the device needs
 * from the person holding it — a button press, a PIN, a passphrase — before
 * the answer arrives. The protocol has no message ids, so exactly one request
 * may be in flight and every reply must be read, or the next request is
 * answered with the last one's leftovers.
 */

/** Initialize is answered at once, whatever the device is showing. */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Every other reply can wait on a person: typing a PIN on the device, reading
 * each output of a transaction. Long enough for that, short enough that a
 * device left on the table gives up.
 */
export const USER_TIMEOUT_MS = 5 * 60_000;

/** How long to wait for the introduction once the device has said something else first. */
const INTERRUPTED_TIMEOUT_MS = 1_500;

/** The Failure a device sends back when told to Cancel. */
const CANCEL_TIMEOUT_MS = 3_000;

/** A silence this long means nothing is left over from an earlier conversation. */
const DRAIN_QUIET_MS = 40;
const DRAIN_MAX_PACKETS = 256;

/** BIP39 caps nothing, but the device does: 50 bytes, not characters. */
const MAX_PASSPHRASE_BYTES = 50;
const MAX_PIN_LENGTH = 50;

export interface Reply {
  type: number;
  message: Message;
}

/** A refusal from the device, with the code it gave for callers that need to tell them apart. */
export class TrezorFailure extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly deviceMessage: string
  ) {
    super(message);
    this.name = 'TrezorFailure';
  }
}

/**
 * For a device that answers the old protocol only to say it does not speak it.
 * That is the Trezor Safe 7, and presumably whatever follows it.
 */
export const THP_ONLY_MESSAGE =
  'This looks like a Trezor Safe 7. It only speaks Trezor’s newer encrypted protocol, ' +
  'which this app cannot use over USB yet.';

function describeFailure(code: number | undefined, text: string): Error {
  const detail = text.trim();
  const said = detail ? ` (“${detail}”)` : '';
  switch (code) {
    case FailureType.ActionCancelled:
      return new UserCancelled('Cancelled on the Trezor.');
    case FailureType.PinCancelled:
      return new UserCancelled('PIN entry was cancelled.');
    case FailureType.PinInvalid:
      return new TrezorFailure(
        'Wrong PIN. Check the keypad on the Trezor screen — its digits move every time — and try again. ' +
          'The Trezor makes you wait longer after each wrong attempt.',
        code,
        detail
      );
    case FailureType.NotInitialized:
      return new TrezorFailure(
        'This Trezor has not been set up yet. Create or recover its wallet in Trezor Suite first, then connect it here.',
        code,
        detail
      );
    case FailureType.InvalidProtocol:
      return new TrezorFailure(THP_ONLY_MESSAGE, code, detail);
    case FailureType.Busy:
      return new TrezorFailure(
        'The Trezor is busy with something else. Finish or cancel what is on its screen, then try again.',
        code,
        detail
      );
    case FailureType.NotEnoughFunds:
      return new TrezorFailure(
        'The Trezor says this transaction spends more than its coins hold. Build the transaction again.',
        code,
        detail
      );
    case FailureType.InvalidSession:
      return new TrezorFailure(
        'The Trezor lost track of this connection. Unplug it, plug it back in and try again.',
        code,
        detail
      );
    case FailureType.FirmwareError:
      return new TrezorFailure(
        `The Trezor hit an internal error${said}. Unplug it, plug it back in and try again.`,
        code,
        detail
      );
    default:
      if (/forbidden key path/i.test(detail)) {
        return new TrezorFailure(
          'The Trezor refused this key path. Its safety checks only allow standard paths; ' +
            'a key kept anywhere else needs them relaxed in Trezor Suite’s device settings.',
          code,
          detail
        );
      }
      return new TrezorFailure(
        detail ? `The Trezor refused: ${detail}` : `The Trezor refused the request (code ${code ?? 'unknown'}).`,
        code,
        detail
      );
  }
}

function buttonStatus(code: number | undefined): string {
  switch (code) {
    case ButtonRequestType.PinEntry:
      return 'Enter your PIN on the Trezor.';
    case ButtonRequestType.PassphraseEntry:
      return 'Enter your passphrase on the Trezor.';
    case ButtonRequestType.ConfirmOutput:
      return 'Check the address and amount on the Trezor, then confirm there.';
    case ButtonRequestType.SignTx:
    case ButtonRequestType.FeeOverThreshold:
      return 'Check the total and the fee on the Trezor, then confirm there.';
    case ButtonRequestType.Warning:
    case ButtonRequestType.UnknownDerivationPath:
      return 'The Trezor is showing a warning. Read it on the device before going on.';
    default:
      return 'Confirm on the Trezor.';
  }
}

/** Trezor normalises passphrases the way BIP39 does; so must anything typed on the phone. */
export function normalisePassphrase(passphrase: string): string {
  return typeof passphrase.normalize === 'function' ? passphrase.normalize('NFKD') : passphrase;
}

export class TrezorSession {
  /** A request is out and its reply has not been read. */
  private inFlight = false;
  /** Replies may be waiting that belong to nothing we are about to ask. */
  private dirty = true;
  /** Set from Features: whether the device has a keyboard of its own for passphrases. */
  capabilities: number[] = [];

  constructor(
    private transport: PacketTransport,
    private prompts: DevicePrompts
  ) {}

  /** Throws away whatever an abandoned conversation left in the pipe. */
  private async drain(): Promise<void> {
    for (let i = 0; i < DRAIN_MAX_PACKETS; i++) {
      try {
        await this.transport.read(DRAIN_QUIET_MS);
      } catch (e) {
        if (e instanceof TransportTimeout) break;
        throw e;
      }
    }
    this.dirty = false;
  }

  private async send(type: number, schema: MessageSchema, message: Message): Promise<void> {
    await writeMessage(this.transport, type, encodeMessage(schema, message));
  }

  private async receive(timeoutMs: number): Promise<Reply> {
    const wire = await readMessage(this.transport, timeoutMs);
    const schema = INCOMING[wire.type];
    if (!schema) throw new Error(`The Trezor sent something unexpected (${messageName(wire.type)}).`);
    return { type: wire.type, message: decodeMessage(schema, wire.data) };
  }

  /**
   * Tells the device to drop what it is doing and reads its acknowledgement,
   * so the screen returns to normal and the pipe is empty for the next request.
   */
  async cancel(): Promise<void> {
    try {
      await this.send(MessageType.Cancel, Empty, {});
      await this.receive(CANCEL_TIMEOUT_MS);
    } catch {
      // Unplugged, or too busy to answer: whatever turns up later is drained
      // before the next request.
      this.dirty = true;
    }
  }

  /**
   * Cancel for when a request is still waiting on the device: the refusal it
   * provokes is read by whoever is waiting, so nothing is read here.
   */
  async cancelInFlight(): Promise<void> {
    try {
      await this.send(MessageType.Cancel, Empty, {});
    } catch {
      this.dirty = true;
    }
  }

  /**
   * Opens the conversation. Initialize also makes the device drop whatever an
   * earlier host left it doing, so this is the one request that is safe to
   * send without knowing what state the device is in.
   */
  async initialize(): Promise<Reply> {
    await this.drain();
    await this.send(MessageType.Initialize, Initialize, {});
    // A device interrupted in the middle of something may first report how
    // that ended. Its introduction follows.
    let lastWords: Reply | null = null;
    for (let replies = 0; replies < 4; replies++) {
      let reply: Reply;
      try {
        reply = await this.receive(lastWords ? INTERRUPTED_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
      } catch (e) {
        this.dirty = true;
        if (!(e instanceof TransportTimeout)) throw e;
        if (lastWords) return lastWords;
        throw new Error(
          'The Trezor is not answering. Unplug it, plug it back in, and check nothing else (such as Trezor Suite) is using it.'
        );
      }
      if (reply.type === MessageType.Features) return reply;
      if (reply.type === MessageType.Failure && reply.message.code === FailureType.InvalidProtocol) return reply;
      lastWords = reply;
    }
    this.dirty = true;
    return lastWords!;
  }

  /** Ends the session so the device forgets the passphrase it was holding for us. Best effort. */
  async endSession(): Promise<void> {
    try {
      await this.exchange(MessageType.EndSession, Empty, {}, CANCEL_TIMEOUT_MS);
    } catch {
      // Older firmware has no such message, and a device being unplugged has
      // forgotten everything anyway.
    }
  }

  /** One request and its immediate reply, with nothing handled in between. */
  async exchange(type: number, schema: MessageSchema, message: Message, timeoutMs = USER_TIMEOUT_MS): Promise<Reply> {
    await this.send(type, schema, message);
    try {
      return await this.receive(timeoutMs);
    } catch (e) {
      // Whatever went wrong, a reply may still be on its way.
      this.dirty = true;
      throw e;
    }
  }

  private async askPin(): Promise<Reply> {
    let pin: string;
    try {
      pin = await this.prompts.pinMatrix();
    } catch (e) {
      await this.cancel();
      throw e;
    }
    if (!/^[1-9]+$/.test(pin) || pin.length > MAX_PIN_LENGTH) {
      await this.cancel();
      throw new Error('A PIN is entered as keypad positions 1 to 9.');
    }
    return this.exchange(MessageType.PinMatrixAck, PinMatrixAck, { pin });
  }

  private async askPassphrase(request: Message): Promise<Reply> {
    // Firmware from before 2020 announced on-device entry in the request itself.
    if (request._on_device === true) {
      this.prompts.status('Enter your passphrase on the Trezor.');
      return this.exchange(MessageType.PassphraseAck, PassphraseAck, {});
    }
    const canEnterOnDevice = this.capabilities.includes(CAPABILITY_PASSPHRASE_ENTRY);
    let entered: string | null;
    try {
      entered = await this.prompts.passphrase(canEnterOnDevice);
    } catch (e) {
      await this.cancel();
      throw e;
    }
    if (entered === null) {
      if (!canEnterOnDevice) {
        await this.cancel();
        throw new Error('This Trezor has no keyboard of its own — type the passphrase on the phone.');
      }
      this.prompts.status('Enter your passphrase on the Trezor.');
      return this.exchange(MessageType.PassphraseAck, PassphraseAck, { on_device: true });
    }
    const passphrase = normalisePassphrase(entered);
    if (Buffer.from(passphrase, 'utf8').length > MAX_PASSPHRASE_BYTES) {
      await this.cancel();
      throw new Error('That passphrase is too long for a Trezor — the limit is 50 bytes.');
    }
    return this.exchange(MessageType.PassphraseAck, PassphraseAck, { passphrase, on_device: false });
  }

  /**
   * Sends a request and sees it through: button presses are acknowledged, the
   * PIN and passphrase are asked for, a Failure becomes an error. Resolves
   * with the reply once it is the `expect`ed kind.
   */
  async call(type: number, schema: MessageSchema, message: Message, expect: number): Promise<Message> {
    if (this.inFlight) throw new Error('The Trezor is still busy with the last request.');
    this.inFlight = true;
    try {
      if (this.dirty) await this.drain();
      let reply = await this.exchange(type, schema, message);
      // A device that keeps asking without ever answering is broken or hostile.
      for (let rounds = 0; rounds < 200; rounds++) {
        switch (reply.type) {
          case MessageType.ButtonRequest:
            // Acknowledge first, so the device shows its screen without waiting on ours.
            await this.send(MessageType.ButtonAck, Empty, {});
            this.prompts.status(buttonStatus(reply.message.code));
            reply = await this.receiveOrGiveUp();
            break;
          case MessageType.PinMatrixRequest:
            reply = await this.askPin();
            break;
          case MessageType.PassphraseRequest:
            reply = await this.askPassphrase(reply.message);
            break;
          case MessageType.Deprecated_PassphraseStateRequest:
            reply = await this.exchange(MessageType.Deprecated_PassphraseStateAck, Empty, {});
            break;
          case MessageType.Failure:
            throw describeFailure(reply.message.code, reply.message.message ?? '');
          default:
            if (reply.type !== expect) {
              await this.cancel();
              throw new Error(
                `The Trezor answered with ${messageName(reply.type)} where ${messageName(expect)} was expected.`
              );
            }
            return reply.message;
        }
      }
      await this.cancel();
      throw new Error('The Trezor kept asking for confirmation without finishing. Unplug it and try again.');
    } catch (e) {
      if (e instanceof TransportTimeout) {
        // Nobody pressed anything. Take the question off the device's screen.
        await this.cancel();
        throw new Error('The Trezor did not answer in time. Wake it up, unlock it and try again.');
      }
      throw e;
    } finally {
      this.inFlight = false;
    }
  }

  private async receiveOrGiveUp(): Promise<Reply> {
    try {
      return await this.receive(USER_TIMEOUT_MS);
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }
}

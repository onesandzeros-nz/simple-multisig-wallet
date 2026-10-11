import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { bip32 } from '../src/lib/bitcoin';
import { decodeMessage, encodeMessage, Message, MessageSchema } from '../src/lib/hw/protobuf';
import { PacketTransport, TransportTimeout } from '../src/lib/hw/types';
import { encodePackets } from '../src/lib/hw/trezor/codec';
import {
  ButtonRequest,
  Failure,
  Features,
  GetPublicKey,
  MessageType,
  PassphraseAck,
  PinMatrixAck,
  PublicKey,
  SignTx,
  TxAck,
  TxRequest,
} from '../src/lib/hw/trezor/messages';

/**
 * A Trezor made of TypeScript, for the tests that have to run with no
 * emulator: it speaks whole messages the way the firmware does, rebuilds the
 * transaction from what it is sent, and signs what it rebuilt — so a driver
 * that sends the wrong thing gets signatures that do not verify.
 */
export interface Wire {
  type: number;
  message: Message;
}

/** Schemas for what the host sends, which the driver itself never has to decode. */
const FROM_HOST: Record<number, MessageSchema> = {
  [MessageType.Initialize]: {},
  [MessageType.GetPublicKey]: GetPublicKey,
  [MessageType.SignTx]: SignTx,
  [MessageType.TxAck]: TxAck,
  [MessageType.PinMatrixAck]: PinMatrixAck,
  [MessageType.PassphraseAck]: PassphraseAck,
  [MessageType.ButtonAck]: {},
  [MessageType.Cancel]: {},
  [MessageType.EndSession]: {},
  [MessageType.Deprecated_PassphraseStateAck]: {},
};

const TO_HOST: Record<number, MessageSchema> = {
  [MessageType.Features]: Features,
  [MessageType.Failure]: Failure,
  [MessageType.Success]: { message: { id: 1, type: 'string' } },
  [MessageType.PublicKey]: PublicKey,
  [MessageType.TxRequest]: TxRequest,
  [MessageType.ButtonRequest]: ButtonRequest,
  [MessageType.PinMatrixRequest]: { type: { id: 1, type: 'enum' } },
  [MessageType.PassphraseRequest]: { _on_device: { id: 1, type: 'bool' } },
  [MessageType.Deprecated_PassphraseStateRequest]: {},
};

/** A workflow on the device: it sends something, waits for the host, and so on until it is done. */
export type Workflow = Generator<Wire, Wire, Wire>;

const failure = (code: number, message: string): Wire => ({ type: MessageType.Failure, message: { code, message } });

/**
 * Behaves like Trezor firmware at the level of whole messages, over a
 * transport that never waits: when nothing is left to read, the read times
 * out at once, as if the person at the device had walked away.
 */
export class SimulatedTrezor implements PacketTransport {
  readonly packetSize = 64;

  // What the device is.
  mnemonic: string;
  features: Message = {
    vendor: 'trezor.io',
    major_version: 2,
    minor_version: 8,
    patch_version: 10,
    initialized: true,
    unlocked: true,
    pin_protection: false,
    passphrase_protection: false,
    firmware_present: true,
    model: 'T',
    internal_model: 'T2T1',
    label: 'Simulated',
    capabilities: [1, 17],
  };
  /** Set to make the device want a PIN typed on the phone, as a Model One does. */
  pin: string | null = null;
  /** The scrambled keypad the device is "showing", top row first. */
  matrix = '847315926';
  /** What the person does when asked to confirm. */
  onButton: 'confirm' | 'reject' | 'walk-away' = 'confirm';
  /** When true the device sorts keys itself (2.8.7 and later); otherwise it takes them as given. */
  sortsKeys = true;
  /** Replaces the device altogether: every message gets what this returns. */
  override: ((incoming: Wire) => Wire[] | null) | null = null;

  // What happened.
  received: Wire[] = [];
  sent: Wire[] = [];
  closed = false;

  private passphrase: string | null = null;
  private inbox: Buffer[] = [];
  private partial: { type: number; length: number; chunks: Buffer[]; have: number } | null = null;
  private workflow: Workflow | null = null;

  constructor(mnemonic: string) {
    this.mnemonic = mnemonic;
  }

  /** Puts raw packets in front of whatever the device says next, like leftovers from an earlier host. */
  leaveBehind(...packets: Buffer[]): void {
    this.inbox.push(...packets);
  }

  typesReceived(): number[] {
    return this.received.map((w) => w.type);
  }

  // --- transport ------------------------------------------------------------

  async write(packet: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('The device was unplugged.');
    const bytes = Buffer.from(packet);
    if (bytes.length !== 64 || bytes[0] !== 0x3f) throw new Error('Simulated Trezor got a malformed packet.');
    if (!this.partial) {
      if (bytes[1] !== 0x23 || bytes[2] !== 0x23) throw new Error('Simulated Trezor expected a message header.');
      this.partial = { type: bytes.readUInt16BE(3), length: bytes.readUInt32BE(5), chunks: [], have: 0 };
      this.partial.chunks.push(bytes.subarray(9));
      this.partial.have += 55;
    } else {
      this.partial.chunks.push(bytes.subarray(1));
      this.partial.have += 63;
    }
    if (this.partial.have < this.partial.length) return;
    const { type, length, chunks } = this.partial;
    this.partial = null;
    const schema = FROM_HOST[type];
    if (!schema) throw new Error(`Simulated Trezor does not know message ${type}.`);
    const incoming = { type, message: decodeMessage(schema, Buffer.concat(chunks).subarray(0, length)) };
    this.received.push(incoming);
    for (const reply of this.respond(incoming)) this.deliver(reply);
  }

  private deliver(reply: Wire): void {
    this.sent.push(reply);
    const schema = TO_HOST[reply.type];
    if (!schema) throw new Error(`Simulated Trezor cannot send message ${reply.type}.`);
    this.inbox.push(...encodePackets(reply.type, encodeMessage(schema, reply.message)));
  }

  async read(): Promise<Uint8Array> {
    if (this.closed) throw new Error('The device was unplugged.');
    const packet = this.inbox.shift();
    if (!packet) throw new TransportTimeout();
    return packet;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // --- behaviour ------------------------------------------------------------

  private respond(incoming: Wire): Wire[] {
    if (this.override) {
      const scripted = this.override(incoming);
      if (scripted) return scripted;
    }
    if (incoming.type === MessageType.Initialize) {
      this.workflow = null;
      return [{ type: MessageType.Features, message: { ...this.features, session_id: Buffer.alloc(32, 7) } }];
    }
    if (incoming.type === MessageType.Cancel) {
      const wasBusy = this.workflow !== null;
      this.workflow = null;
      return [failure(wasBusy ? 4 : 1, wasBusy ? 'Cancelled' : 'Unexpected message')];
    }
    if (incoming.type === MessageType.EndSession) {
      this.passphrase = null;
      return [{ type: MessageType.Success, message: { message: 'Session ended' } }];
    }

    let step: IteratorResult<Wire, Wire>;
    if (this.workflow) {
      step = this.workflow.next(incoming);
    } else {
      if (incoming.type === MessageType.GetPublicKey) this.workflow = this.getPublicKey(incoming.message);
      else if (incoming.type === MessageType.SignTx) this.workflow = this.signTx(incoming.message);
      else return [failure(1, 'Unexpected message')];
      step = this.workflow.next(incoming);
    }
    if (step.done) this.workflow = null;
    // Someone who walks away leaves the question on the screen, unanswered.
    return step.value ? [step.value] : [];
  }

  private *button(code: number): Generator<Wire, void, Wire> {
    const ack = yield { type: MessageType.ButtonRequest, message: { code } };
    if (ack.type !== MessageType.ButtonAck) throw failure(1, 'Unexpected message');
    if (this.onButton === 'reject') throw failure(4, 'Cancelled');
    if (this.onButton === 'walk-away') {
      // Nothing more is said until the host gives up and cancels.
      yield undefined as unknown as Wire;
      throw failure(4, 'Cancelled');
    }
  }

  private *unlock(): Generator<Wire, void, Wire> {
    if (this.pin !== null && !this.features.unlocked) {
      const ack = yield { type: MessageType.PinMatrixRequest, message: { type: 1 } };
      if (ack.type !== MessageType.PinMatrixAck) throw failure(1, 'Unexpected message');
      const typed = [...String(ack.message.pin)].map((position) => this.matrix[Number(position) - 1]).join('');
      if (typed !== this.pin) throw failure(7, 'PIN invalid');
      this.features = { ...this.features, unlocked: true };
    }
    if (this.features.passphrase_protection && this.passphrase === null) {
      const ack = yield { type: MessageType.PassphraseRequest, message: {} };
      if (ack.type !== MessageType.PassphraseAck) throw failure(1, 'Unexpected message');
      if (ack.message.on_device) {
        yield* this.button(19);
        this.passphrase = 'typed on device';
      } else {
        this.passphrase = ack.message.passphrase ?? '';
      }
    }
  }

  private root(network: bitcoin.Network) {
    return bip32.fromSeed(bip39.mnemonicToSeedSync(this.mnemonic, this.passphrase ?? ''), network);
  }

  private *guarded(body: Generator<Wire, Wire, Wire>): Workflow {
    try {
      return yield* body;
    } catch (thrown: any) {
      if (thrown && typeof thrown.type === 'number') return thrown as Wire;
      throw thrown;
    }
  }

  private getPublicKey(request: Message): Workflow {
    const self = this;
    return this.guarded(
      (function* (): Generator<Wire, Wire, Wire> {
        yield* self.unlock();
        const network = request.coin_name === 'Testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
        const root = self.root(network);
        let node = root;
        for (const step of request.address_n as number[]) {
          node = step >= 0x80000000 ? node.deriveHardened(step - 0x80000000) : node.derive(step);
        }
        return {
          type: MessageType.PublicKey,
          message: {
            node: {
              depth: node.depth,
              fingerprint: node.parentFingerprint >>> 0,
              child_num: node.index >>> 0,
              chain_code: Buffer.from(node.chainCode),
              public_key: Buffer.from(node.publicKey),
            },
            xpub: node.neutered().toBase58(),
            root_fingerprint: Buffer.from(root.fingerprint).readUInt32BE(0),
          },
        };
      })()
    );
  }

  /** The keys of a multisig, in the order the script will have them. */
  private multisigKeys(multisig: Message): Buffer[] {
    const keys = (multisig.nodes as Message[]).map((node) => {
      let key = bip32.fromPublicKey(Buffer.from(node.public_key), Buffer.from(node.chain_code));
      for (const step of multisig.address_n as number[]) key = key.derive(step);
      return Buffer.from(key.publicKey);
    });
    const sorted = this.sortsKeys && multisig.pubkeys_order === 1;
    return sorted ? keys.sort((a, b) => a.compare(b)) : keys;
  }

  private witnessScript(multisig: Message, network: bitcoin.Network): Buffer {
    return bitcoin.payments.p2ms({ m: multisig.m, pubkeys: this.multisigKeys(multisig), network }).output!;
  }

  /** Which set of cosigner keys this is, regardless of the order they came in. */
  private multisigIdentity(multisig: Message): string {
    return [
      multisig.m,
      ...(multisig.nodes as Message[]).map((n) => Buffer.from(n.public_key).toString('hex')).sort(),
    ].join(':');
  }

  private signTx(request: Message): Workflow {
    const self = this;
    return this.guarded(
      (function* (): Generator<Wire, Wire, Wire> {
        yield* self.unlock();
        const network = request.coin_name === 'Testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
        const root = self.root(network);

        const ask = function* (
          kind: number,
          details: Message,
          serialized?: Message
        ): Generator<Wire, Message, Wire> {
          const ack = yield { type: MessageType.TxRequest, message: { request_type: kind, details, serialized } };
          if (ack.type !== MessageType.TxAck) throw failure(1, 'Unexpected message');
          return ack.message.tx ?? {};
        };

        // 1. Every input.
        const inputs: Message[] = [];
        for (let i = 0; i < request.inputs_count; i++) {
          const input = (yield* ask(0, { request_index: i })).inputs?.[0];
          if (!input || input.script_type !== 3 || !input.multisig) throw failure(3, 'Invalid input');
          if (input.amount === undefined) throw failure(3, 'Expected input with amount');
          inputs.push(input);
        }
        const wallet = new Set(inputs.map((input) => self.multisigIdentity(input.multisig)));
        const account = JSON.stringify((inputs[0].address_n as number[]).slice(0, -2));

        // 2. Every output, shown unless it is the wallet's own change.
        const outputs: { script: Buffer; amount: number }[] = [];
        for (let i = 0; i < request.outputs_count; i++) {
          const output = (yield* ask(1, { request_index: i })).outputs?.[0];
          if (!output) throw failure(3, 'Missing output');
          let script: Buffer;
          let isChange = false;
          if (output.address_n?.length) {
            if (output.script_type !== 4 || !output.multisig) throw failure(3, 'Invalid change output');
            script = bitcoin.payments.p2wsh({
              redeem: { output: self.witnessScript(output.multisig, network), network },
              network,
            }).output!;
            isChange =
              wallet.size === 1 &&
              wallet.has(self.multisigIdentity(output.multisig)) &&
              JSON.stringify((output.address_n as number[]).slice(0, -2)) === account &&
              output.address_n[output.address_n.length - 2] <= 1;
          } else if (output.script_type === 3) {
            script = bitcoin.payments.embed({ data: [Buffer.from(output.op_return_data)] }).output!;
          } else {
            try {
              script = bitcoin.address.toOutputScript(output.address, network);
            } catch {
              throw failure(3, 'Invalid address');
            }
          }
          outputs.push({ script, amount: output.amount });
          if (!isChange) yield* self.button(3);
        }
        yield* self.button(8);

        // 3. The transaction each input spends, to check what it is worth.
        for (const input of inputs) {
          const hash = Buffer.from(input.prev_hash);
          const meta = yield* ask(2, { tx_hash: hash });
          const previous = new bitcoin.Transaction();
          previous.version = meta.version;
          previous.locktime = meta.lock_time;
          for (let i = 0; i < meta.inputs_cnt; i++) {
            const part = (yield* ask(0, { request_index: i, tx_hash: hash })).inputs?.[0];
            if (!part) throw failure(3, 'Missing previous input');
            previous.addInput(
              Buffer.from(part.prev_hash).reverse(),
              part.prev_index,
              part.sequence,
              Buffer.from(part.script_sig ?? [])
            );
          }
          for (let i = 0; i < meta.outputs_cnt; i++) {
            const part = (yield* ask(1, { request_index: i, tx_hash: hash })).bin_outputs?.[0];
            if (!part) throw failure(3, 'Missing previous output');
            previous.addOutput(Buffer.from(part.script_pubkey), part.amount);
          }
          if (previous.getId() !== hash.toString('hex')) throw failure(9, 'Encountered invalid prev_hash');
          const spent = previous.outs[input.prev_index];
          const expected = bitcoin.payments.p2wsh({
            redeem: { output: self.witnessScript(input.multisig, network), network },
            network,
          }).output!;
          if (!spent || spent.value !== input.amount) throw failure(3, 'Invalid amount specified');
          if (!Buffer.from(spent.script).equals(expected)) throw failure(3, 'Input does not match scriptPubKey');
        }

        // 4. Sign, handing each signature back with the next request.
        const tx = new bitcoin.Transaction();
        tx.version = request.version;
        tx.locktime = request.lock_time;
        for (const input of inputs) tx.addInput(Buffer.from(input.prev_hash).reverse(), input.prev_index, input.sequence);
        for (const output of outputs) tx.addOutput(output.script, output.amount);

        let last: Message | undefined;
        for (let i = 0; i < inputs.length; i++) {
          const again = (yield* ask(0, { request_index: i }, last)).inputs?.[0];
          if (!again || JSON.stringify(again) !== JSON.stringify(inputs[i])) {
            throw failure(9, 'Transaction has changed during signing');
          }
          let key = root;
          for (const step of again.address_n as number[]) {
            key = step >= 0x80000000 ? key.deriveHardened(step - 0x80000000) : key.derive(step);
          }
          const script = self.witnessScript(again.multisig, network);
          if (!self.multisigKeys(again.multisig).some((k) => k.equals(Buffer.from(key.publicKey)))) {
            throw failure(3, 'Pubkey not found in multisig script');
          }
          const digest = tx.hashForWitnessV0(i, script, again.amount, bitcoin.Transaction.SIGHASH_ALL);
          const signature = Buffer.from(ecc.sign(digest, key.privateKey!));
          const der = bitcoin.script.signature.encode(signature, bitcoin.Transaction.SIGHASH_ALL);
          last = { signature_index: i, signature: Buffer.from(der.subarray(0, der.length - 1)) };
        }
        return { type: MessageType.TxRequest, message: { request_type: 3, serialized: last } };
      })()
    );
  }
}

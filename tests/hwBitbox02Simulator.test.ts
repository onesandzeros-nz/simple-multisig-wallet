import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import ecc from '@bitcoinerlab/secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { accountXpub, bip48Path, deriveAddress, masterFingerprint } from '../src/lib/bitcoin';
import { BitBox02Device } from '../src/lib/hw/bitbox02';
import { DeviceMemory, DevicePrompts, PacketTransport, TransportTimeout } from '../src/lib/hw/types';
import { MultisigWallet, NetworkName, Utxo, WalletSnapshot } from '../src/lib/types';
import {
  attachSignatures,
  buildPsbt,
  finalizeAndExtract,
  parsePsbt,
  signingJobsFor,
  signPsbtWithMnemonic,
  summarisePsbt,
} from '../src/lib/wallet';
import { MNEMONICS } from './helpers';

/**
 * The driver against the real firmware, running in the manufacturer's
 * simulator. Skipped unless BITBOX02_SIMULATOR names the simulator binary:
 *
 *   curl -L -o bitbox02-sim https://github.com/BitBoxSwiss/bitbox02-firmware/releases/download/firmware%2Fv9.27.1/bitbox02-multi-v9.27.1-simulator1.0.0-linux-amd64
 *   chmod +x bitbox02-sim
 *   BITBOX02_SIMULATOR=$PWD/bitbox02-sim node --import tsx --test tests/hwBitbox02Simulator.test.ts
 *
 * (linux/amd64 only.) The simulator speaks the same 64-byte packets over TCP
 * that a device speaks over USB, presses "confirm" on every screen by itself,
 * and prints each screen it would have shown — which is how these tests know
 * what a person would have been asked to approve.
 */
const SIMULATOR = process.env.BITBOX02_SIMULATOR;

/** "bitbox02-multi-v9.27.1-simulator1.0.0-linux-amd64" → [9, 27, 1] */
const FIRMWARE: number[] = SIMULATOR
  ? (/-v(\d+)\.(\d+)\.(\d+)-/.exec(String(spawnSync(SIMULATOR, ['--version']).stdout)) ?? []).slice(1).map(Number)
  : [];
const since = (major: number, minor: number) => FIRMWARE[0] > major || (FIRMWARE[0] === major && FIRMWARE[1] >= minor);
/** From 9.26 the device draws addresses in groups of four. */
const drawn = (address: string) => (since(9, 26) ? address.match(/.{1,4}/g)!.join(' ') : address);

/** A port nothing is using: the simulator's own lingers for a while after it exits. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The seed the simulator restores when asked to restore from a mnemonic. */
const SIMULATOR_MNEMONIC =
  'boring mistake dish oyster truth pigeon viable emerge sort crash wire portion cannon couple enact box walk height pull today solid off enable tide';

class TcpTransport implements PacketTransport {
  readonly packetSize = 64;
  private buffered = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake?.();
    });
    const gone = (e?: Error) => {
      this.failure = e ?? new Error('The simulator closed the connection.');
      this.wake?.();
    };
    socket.on('error', gone);
    socket.on('close', () => gone());
  }

  static connect(port: number): Promise<TcpTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port, noDelay: true });
      socket.once('connect', () => resolve(new TcpTransport(socket)));
      socket.once('error', reject);
    });
  }

  write(packet: Uint8Array): Promise<void> {
    assert.equal(packet.length, this.packetSize, 'every packet written is a whole one');
    return new Promise((resolve, reject) => {
      this.socket.write(packet, (e) => (e ? reject(e) : resolve()));
    });
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffered.length < this.packetSize) {
      if (this.failure) throw this.failure;
      const left = deadline - Date.now();
      if (left <= 0) throw new TransportTimeout();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    const packet = this.buffered.subarray(0, this.packetSize);
    this.buffered = this.buffered.subarray(this.packetSize);
    return Uint8Array.from(packet);
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

class MapMemory implements DeviceMemory {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
}

class RecordingPrompts implements DevicePrompts {
  readonly statuses: string[] = [];
  readonly pairingCodes: string[] = [];
  status(message: string) {
    this.statuses.push(message);
  }
  async pinMatrix(): Promise<string> {
    throw new Error('A BitBox02 never asks for a PIN on the phone.');
  }
  async passphrase(): Promise<string | null> {
    throw new Error('A BitBox02 never asks for a passphrase on the phone.');
  }
  async confirmPairing(code: string) {
    this.pairingCodes.push(code);
    return true;
  }
}

function walletWithSimulator(m: number, network: NetworkName, name: string): MultisigWallet {
  const mnemonics = [MNEMONICS[0], SIMULATOR_MNEMONIC, MNEMONICS[1]];
  return {
    id: `sim-${network}`,
    kind: 'private',
    name,
    m,
    n: mnemonics.length,
    network,
    scriptType: 'P2WSH',
    cosigners: mnemonics.map((mnemonic, i) => ({
      name: `Signer ${i + 1}`,
      fingerprint: masterFingerprint(mnemonic),
      path: bip48Path(network),
      xpub: accountXpub(mnemonic, network),
    })),
    createdAt: 0,
  };
}

/**
 * Real coins for the wallet's first receive addresses: one transaction per
 * coin, each with an unrelated input and a decoy output beside the one that
 * pays the wallet, so the device has genuine previous transactions to hash.
 */
function fund(wallet: MultisigWallet, values: number[]): { snapshot: WalletSnapshot; funding: Map<string, Buffer> } {
  const funding = new Map<string, Buffer>();
  const utxos: Utxo[] = values.map((value, i) => {
    const address = deriveAddress(wallet, 0, i);
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.locktime = 100 + i;
    tx.addInput(Buffer.alloc(32, 0x40 + i), i, 0xfffffffe, Buffer.from('0014' + '11'.repeat(20), 'hex'));
    tx.addOutput(Buffer.from('0014' + '22'.repeat(20), 'hex'), 12_345);
    tx.addOutput(address.script, value);
    funding.set(tx.getId(), tx.toBuffer());
    return { txid: tx.getId(), vout: 1, value, address: address.address, branch: 0, index: i, confirmed: true };
  });
  return {
    funding,
    snapshot: {
      confirmedSats: values.reduce((s, v) => s + v, 0),
      unconfirmedSats: 0,
      utxos,
      usedAddresses: [],
      nextReceiveIndex: values.length,
      nextChangeIndex: 0,
      scannedAt: 0,
    },
  };
}

const RECIPIENT: Record<NetworkName, string> = {
  mainnet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  testnet: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
};

describe('BitBox02 driver against the firmware simulator', { skip: !SIMULATOR && 'set BITBOX02_SIMULATOR to run' }, () => {
  let PORT = 0;
  let simulator: ChildProcess;
  let screens = '';
  const lineBuffered = spawnSync('stdbuf', ['--version']).status === 0;
  /** Simulators before 9.20 print the registration screens but not the transaction's. */
  const printsTransactions = lineBuffered && since(9, 20);
  const memory = new MapMemory();
  const prompts = new RecordingPrompts();
  let device: BitBox02Device;

  const open = async (testing: { allowUninitialized?: boolean } = {}) =>
    new BitBox02Device(await TcpTransport.connect(PORT), {
      prompts,
      memory,
      // The simulator has no factory certificate; a real device is never excused.
      testing: { skipAttestation: true, ...testing },
    });

  /** What the simulator has drawn since `from`, once it has stopped drawing. */
  const screensSince = async (from: number): Promise<string> => {
    let seen = -1;
    while (seen !== screens.length) {
      seen = screens.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return screens.slice(from);
  };

  before(async () => {
    assert.equal(FIRMWARE.length, 3, 'BITBOX02_SIMULATOR is not a BitBox02 simulator');
    PORT = await freePort();
    // Line-buffered, so screens arrive as they are drawn rather than when the
    // process exits.
    simulator = lineBuffered
      ? spawn('stdbuf', ['-oL', SIMULATOR!, '--port', String(PORT)])
      : spawn(SIMULATOR!, ['--port', String(PORT)]);
    simulator.stdout?.on('data', (chunk) => (screens += chunk.toString('utf8')));
    for (let tries = 0; ; tries++) {
      try {
        (await TcpTransport.connect(PORT)).close();
        break;
      } catch (e) {
        if (tries > 200) throw e;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    // The probe above was a connection of its own; let the simulator see it close.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  after(async () => {
    if (process.env.BITBOX02_SIMULATOR_SCREENS) console.log(screens);
    await device?.close().catch(() => {});
    simulator?.kill('SIGKILL');
  });

  it('refuses a device that has not been set up', async () => {
    const blank = await open();
    await assert.rejects(blank.connect(), /has not been set up yet/);
    await blank.close();
  });

  it('refuses a device that cannot prove it is genuine', async () => {
    const unattested = new BitBox02Device(await TcpTransport.connect(PORT), {
      prompts: new RecordingPrompts(),
      memory: new MapMemory(),
      testing: { allowUninitialized: true },
    });
    await assert.rejects(unattested.connect(), /could not prove it is a genuine BitBox02/);
    await unattested.close();
  });

  it('pairs, showing the same code the device shows', async () => {
    const from = screens.length;
    const blank = await open({ allowUninitialized: true });
    const info = await blank.connect();
    assert.match(info.model, /^BitBox02/);
    assert.equal(info.firmware, FIRMWARE.join('.'));

    assert.equal(prompts.pairingCodes.length, 1);
    assert.match(prompts.pairingCodes[0], /^[A-Z2-7]{5} [A-Z2-7]{5}\n[A-Z2-7]{5} [A-Z2-7]{5}$/);
    if (lineBuffered) {
      const shown = await screensSince(from);
      assert.ok(shown.includes(`TITLE: Pairing code\nBODY: ${prompts.pairingCodes[0]}\n`), shown);
    }
    assert.equal(memory.values.size, 2, 'the phone key and the paired device are remembered');

    // Seed it, as the BitBoxApp would have.
    const restored = await blank.testingQuery({
      restore_from_mnemonic: { timestamp: Math.floor(Date.now() / 1000), timezone_offset: 0 },
    });
    assert.ok(restored.success);
    await blank.close();
  });

  it('reconnects without pairing again', async () => {
    device = await open();
    const info = await device.connect();
    assert.match(info.label ?? '', /BitBox/, 'the name the device goes by');
    assert.equal(prompts.pairingCodes.length, 1, 'no second pairing prompt');
  });

  it('reads the master fingerprint', async () => {
    assert.equal(await device.masterFingerprint(), masterFingerprint(SIMULATOR_MNEMONIC));
    assert.equal(await device.masterFingerprint(), '4c00739d');
  });

  it('exports the BIP48 account key on both networks', async () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const key = await device.getKey(network);
      assert.deepEqual(key, {
        xpub: accountXpub(SIMULATOR_MNEMONIC, network),
        fingerprint: '4c00739d',
        path: bip48Path(network),
        network,
      });
    }
    const second = await device.getKey('mainnet', "m/48'/0'/1'/2'");
    assert.equal(second.path, "m/48'/0'/1'/2'");
    assert.notEqual(second.xpub, accountXpub(SIMULATOR_MNEMONIC, 'mainnet'));
  });

  for (const network of ['mainnet', 'testnet'] as const) {
    it(`registers a 2-of-3 wallet and signs a spend with change (${network})`, async () => {
      const wallet = walletWithSimulator(2, network, `Family savings ₿ ${network}`);
      const { snapshot, funding } = fund(wallet, [150_000, 90_000]);
      // More than the larger coin holds, so both are spent and change comes back.
      const built = buildPsbt(wallet, snapshot, RECIPIENT[network], 200_000, 3, false);
      assert.equal(built.usedUtxos.length, 2);
      assert.ok(built.changeSats > 0);
      const draft = built.psbt.toBase64();

      // As the app does it: previous transactions are added to a working copy
      // for the device, and only signatures go back onto the draft.
      const forDevice = parsePsbt(draft, network);
      forDevice.txInputs.forEach((input, i) => {
        const txid = Buffer.from(input.hash).reverse().toString('hex');
        forDevice.updateInput(i, { nonWitnessUtxo: funding.get(txid)! });
      });

      const from = screens.length;
      prompts.statuses.length = 0;
      const signatures = await device.signMultisig({ wallet, psbt: forDevice, fingerprint: '4c00739d' });
      assert.equal(signatures.length, 2);
      assert.match(prompts.statuses[0], /has not seen this wallet before/);
      assert.match(prompts.statuses[0], new RegExp(`“Family savings ${network}”`));
      assert.match(prompts.statuses[1], /Check the transaction on the BitBox02/);

      const jobs = signingJobsFor(draft, '4c00739d', network);
      assert.equal(jobs.length, 2);
      for (const job of jobs) {
        const signature = signatures.find((s) => s.index === job.index)!;
        assert.ok(signature.pubkey.equals(job.pubkey), 'signed with the key the wallet expects');
        assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature), 'valid for the BIP143 sighash');
      }
      const signed = attachSignatures(
        draft,
        network,
        jobs.map((job) => ({ job, signature: signatures.find((s) => s.index === job.index)!.signature }))
      );
      assert.deepEqual(summarisePsbt(parsePsbt(signed, network), wallet).signedBy, ['4c00739d']);

      // A second cosigner completes it, and the result is a valid transaction.
      const complete = parsePsbt(signed, network);
      assert.equal(signPsbtWithMnemonic(complete, MNEMONICS[0], wallet), 2);
      assert.ok(complete.validateSignaturesOfAllInputs((pubkey, hash, sig) => ecc.verify(hash, pubkey, sig)));
      const tx = bitcoin.Transaction.fromHex(finalizeAndExtract(complete));
      assert.equal(tx.ins.length, 2);
      assert.equal(tx.outs.length, 2);
      for (const input of tx.ins) assert.equal(input.witness.length, 4, 'empty item, two signatures, script');

      if (lineBuffered) {
        const shown = await screensSince(from);
        // The wallet was shown for approval, cosigner by cosigner…
        assert.ok(shown.includes('TITLE: Register\nBODY: 2-of-3\n'), shown);
        assert.ok(shown.includes(`BODY: Family savings ${network}\n`), shown);
        for (const cosigner of wallet.cosigners) assert.ok(shown.includes(cosigner.xpub), shown);
        assert.ok(shown.includes('Multisig account\nregistered'), shown);
      }
      if (printsTransactions) {
        const shown = await screensSince(from);
        // …and the transaction named the recipient and the amount, and did not
        // pass the change off as a payment.
        assert.ok(shown.includes(drawn(RECIPIENT[network])), shown);
        assert.ok(shown.includes('0.00200000'), shown);
        const change = deriveAddress(wallet, 1, 0).address;
        assert.ok(!shown.includes(drawn(change)) && !shown.includes(change), 'change is not shown as a recipient');
      }

      // The wallet is known now: signing again asks for nothing to be registered.
      prompts.statuses.length = 0;
      const again = await device.signMultisig({ wallet, psbt: forDevice, fingerprint: '4c00739d' });
      assert.equal(again.length, 2);
      assert.equal(prompts.statuses.length, 1);
      assert.match(prompts.statuses[0], /Check the transaction on the BitBox02/);
      // Anti-klepto mixes in fresh randomness, so no two signatures repeat.
      assert.ok(!again[0].signature.equals(signatures[0].signature));
    });
  }

  it('signs a send-everything transaction with one input and no change', async () => {
    const wallet = walletWithSimulator(2, 'mainnet', 'Family savings ₿ mainnet');
    const { snapshot, funding } = fund(wallet, [75_000]);
    const built = buildPsbt(wallet, snapshot, RECIPIENT.mainnet, 0, 2, true);
    assert.equal(built.changeSats, 0);
    const psbt = built.psbt;
    psbt.updateInput(0, { nonWitnessUtxo: funding.get(snapshot.utxos[0].txid)! });
    const [signature] = await device.signMultisig({ wallet, psbt, fingerprint: '4c00739d' });
    const [job] = signingJobsFor(built.psbt.toBase64(), '4c00739d', 'mainnet');
    assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature));
  });

  it('shows a payment dressed up as change for what it is', async () => {
    const wallet = walletWithSimulator(2, 'mainnet', 'Family savings ₿ mainnet');
    const { snapshot, funding } = fund(wallet, [150_000]);
    const built = buildPsbt(wallet, snapshot, RECIPIENT.mainnet, 50_000, 3, false);
    const honest = built.psbt;
    // A hostile draft: the "change" goes to someone else's address, but still
    // carries the wallet's change derivation.
    const thief = bitcoin.address.toOutputScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', bitcoin.networks.bitcoin);
    const hostile = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    hostile.setVersion(2);
    hostile.addInput({
      hash: snapshot.utxos[0].txid,
      index: snapshot.utxos[0].vout,
      sequence: 0xfffffffd,
      witnessUtxo: honest.data.inputs[0].witnessUtxo!,
      witnessScript: honest.data.inputs[0].witnessScript!,
      bip32Derivation: honest.data.inputs[0].bip32Derivation!,
      nonWitnessUtxo: funding.get(snapshot.utxos[0].txid)!,
    });
    hostile.addOutput({ script: honest.txOutputs[0].script, value: honest.txOutputs[0].value });
    hostile.addOutput({
      script: thief,
      value: honest.txOutputs[1].value,
      bip32Derivation: honest.data.outputs[1].bip32Derivation!,
    });

    const from = screens.length;
    const [signature] = await device.signMultisig({ wallet, psbt: hostile, fingerprint: '4c00739d' });
    // The signature is for the transaction as it really is…
    const [job] = signingJobsFor(hostile.toBase64(), '4c00739d', 'mainnet');
    assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature));
    // …and the person holding the device was shown where the money really goes.
    if (printsTransactions) {
      const shown = await screensSince(from);
      assert.ok(shown.includes(drawn('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')), shown);
    }
  });

  it('pays every kind of address, and knows the wallet’s own', async () => {
    const wallet = walletWithSimulator(2, 'mainnet', 'Family savings ₿ mainnet');
    const { snapshot, funding } = fund(wallet, [500_000]);
    const coin = deriveAddress(wallet, 0, 0);
    const ownReceive = deriveAddress(wallet, 0, 7);
    const change = deriveAddress(wallet, 1, 3);
    const recipients: [string, number][] = [
      ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 10_000],
      ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 20_000],
      ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 30_000],
      ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 40_000],
      ['bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 50_000],
    ];
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    psbt.setVersion(2);
    psbt.addInput({
      hash: snapshot.utxos[0].txid,
      index: snapshot.utxos[0].vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: coin.script, value: 500_000 },
      witnessScript: coin.witnessScript,
      bip32Derivation: coin.derivations,
      nonWitnessUtxo: funding.get(snapshot.utxos[0].txid)!,
    });
    for (const [address, value] of recipients) psbt.addOutput({ address, value });
    // Data outputs arrived in 9.24; before that the same money goes to the fee.
    if (since(9, 24)) psbt.addOutput({ script: Buffer.from('6a0b68656c6c6f20776f726c64', 'hex'), value: 0 });
    psbt.addOutput({ script: ownReceive.script, value: 60_000, bip32Derivation: ownReceive.derivations });
    psbt.addOutput({ script: change.script, value: 280_000, bip32Derivation: change.derivations });

    const from = screens.length;
    const [signature] = await device.signMultisig({ wallet, psbt, fingerprint: '4c00739d' });
    const [job] = signingJobsFor(psbt.toBase64(), '4c00739d', 'mainnet');
    assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature));

    if (printsTransactions) {
      const shown = await screensSince(from);
      for (const [address] of recipients) assert.ok(shown.includes(`ADDRESS: ${drawn(address)}`), `${address}\n${shown}`);
      if (since(9, 24)) assert.ok(shown.includes('hello world'), shown);
      // Money coming back to the wallet is called that, not listed as a payment to a stranger.
      assert.ok(shown.includes(`ADDRESS: This BitBox${since(9, 22) ? ' (same account)' : '02'}: ${drawn(ownReceive.address)}`), shown);
      assert.ok(!shown.includes(drawn(change.address)), 'change is not shown at all');
      assert.ok(shown.includes('FEE: 0.00010000 BTC'), shown);
    }
  });

  it('signs for a 3-of-5 wallet spending coins with long histories', async () => {
    const mnemonics = [MNEMONICS[0], MNEMONICS[1], MNEMONICS[2], MNEMONICS[3], SIMULATOR_MNEMONIC];
    const wallet: MultisigWallet = {
      ...walletWithSimulator(3, 'testnet', 'Five keys'),
      n: 5,
      cosigners: mnemonics.map((mnemonic, i) => ({
        name: `Signer ${i + 1}`,
        fingerprint: masterFingerprint(mnemonic),
        path: bip48Path('testnet'),
        xpub: accountXpub(mnemonic, 'testnet'),
      })),
    };
    // Previous transactions with many inputs and outputs, as a consolidation or a batch payout has.
    const funding = new Map<string, Buffer>();
    const utxos: Utxo[] = [0, 1, 2].map((i) => {
      const address = deriveAddress(wallet, i % 2, 40 + i);
      const tx = new bitcoin.Transaction();
      tx.version = 1;
      for (let n = 0; n < 12; n++) tx.addInput(Buffer.alloc(32, 0x60 + i * 16 + n), n, 0xffffffff, Buffer.alloc(107, n));
      for (let n = 0; n < 9; n++) tx.addOutput(Buffer.from('0014' + (10 + n).toString(16).repeat(20), 'hex'), 1_000 + n);
      tx.addOutput(address.script, 70_000 + i);
      funding.set(tx.getId(), tx.toBuffer());
      return { txid: tx.getId(), vout: 9, value: 70_000 + i, address: address.address, branch: i % 2, index: 40 + i, confirmed: true };
    });
    const snapshot: WalletSnapshot = {
      confirmedSats: 210_003,
      unconfirmedSats: 0,
      utxos,
      usedAddresses: [],
      nextReceiveIndex: 50,
      nextChangeIndex: 50,
      scannedAt: 0,
    };
    const built = buildPsbt(wallet, snapshot, RECIPIENT.testnet, 150_000, 1.5, false);
    assert.equal(built.usedUtxos.length, 3);
    const draft = built.psbt.toBase64();
    const psbt = parsePsbt(draft, 'testnet');
    psbt.txInputs.forEach((input, i) => {
      psbt.updateInput(i, { nonWitnessUtxo: funding.get(Buffer.from(input.hash).reverse().toString('hex'))! });
    });

    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: '4c00739d' });
    const jobs = signingJobsFor(draft, '4c00739d', 'testnet');
    assert.equal(jobs.length, 3);
    let signed = attachSignatures(
      draft,
      'testnet',
      jobs.map((job) => ({ job, signature: signatures.find((s) => s.index === job.index)!.signature }))
    );
    const complete = parsePsbt(signed, 'testnet');
    signPsbtWithMnemonic(complete, MNEMONICS[1], wallet);
    signPsbtWithMnemonic(complete, MNEMONICS[3], wallet);
    assert.ok(summarisePsbt(complete, wallet).complete);
    assert.ok(complete.validateSignaturesOfAllInputs((pubkey, hash, sig) => ecc.verify(hash, pubkey, sig)));
    signed = finalizeAndExtract(complete);
    assert.equal(bitcoin.Transaction.fromHex(signed).ins[0].witness.length, 5);
  });

  it('stores a second wallet of the same name under a name of its own', async () => {
    // Same name as the wallet registered above, different keys.
    const first = walletWithSimulator(2, 'mainnet', 'Family savings ₿ mainnet');
    const namesake: MultisigWallet = {
      ...first,
      cosigners: first.cosigners.map((c, i) => (i === 0 ? { ...c, fingerprint: masterFingerprint(MNEMONICS[3]), xpub: accountXpub(MNEMONICS[3], 'mainnet') } : c)),
    };
    const { snapshot, funding } = fund(namesake, [75_000]);
    const psbt = buildPsbt(namesake, snapshot, RECIPIENT.mainnet, 0, 2, true).psbt;
    psbt.updateInput(0, { nonWitnessUtxo: funding.get(snapshot.utxos[0].txid)! });

    const from = screens.length;
    prompts.statuses.length = 0;
    const [signature] = await device.signMultisig({ wallet: namesake, psbt, fingerprint: '4c00739d' });
    const [job] = signingJobsFor(psbt.toBase64(), '4c00739d', 'mainnet');
    assert.ok(ecc.verify(job.digest, job.pubkey, signature.signature));
    assert.match(prompts.statuses[1], /already has a different wallet called “Family savings mainnet”/);
    if (lineBuffered) {
      const shown = await screensSince(from);
      assert.match(shown, /TITLE: Spend from\nBODY: Family savings mainnet [0-9a-f]{4}\n/);
    }
  });

  it('exports a key from an unusual path once the device has warned about it', async () => {
    const from = screens.length;
    prompts.statuses.length = 0;
    const key = await device.getKey('mainnet', "m/48'/0'/0'/5'");
    assert.equal(key.path, "m/48'/0'/0'/5'");
    assert.match(prompts.statuses[0], /unusual key path/);
    if (lineBuffered) assert.ok((await screensSince(from)).includes("unusual keypath m/48'/0'/0'/5'"));
    // Nunchuk's shorter multisig path is one the device knows.
    prompts.statuses.length = 0;
    assert.equal((await device.getKey('mainnet', "m/48'/0'/0'")).path, "m/48'/0'/0'");
    assert.deepEqual(prompts.statuses, []);
  });

  it('refuses to sign as a key it does not hold', async () => {
    const wallet = walletWithSimulator(2, 'mainnet', 'Family savings ₿ mainnet');
    const { snapshot, funding } = fund(wallet, [75_000]);
    const psbt = buildPsbt(wallet, snapshot, RECIPIENT.mainnet, 0, 2, true).psbt;
    psbt.updateInput(0, { nonWitnessUtxo: funding.get(snapshot.utxos[0].txid)! });
    await assert.rejects(
      device.signMultisig({ wallet, psbt, fingerprint: masterFingerprint(MNEMONICS[0]) }),
      /different device.*holds key 4c00739d/
    );

    // Right fingerprint, wrong key behind it: caught before the device is asked to sign.
    const impostor: MultisigWallet = {
      ...wallet,
      cosigners: wallet.cosigners.map((c) =>
        c.fingerprint === '4c00739d' ? { ...c, xpub: accountXpub(MNEMONICS[2], 'mainnet') } : c
      ),
    };
    const funded = fund(impostor, [75_000]);
    const forged = buildPsbt(impostor, funded.snapshot, RECIPIENT.mainnet, 0, 2, true).psbt;
    forged.updateInput(0, { nonWitnessUtxo: funded.funding.get(funded.snapshot.utxos[0].txid)! });
    await assert.rejects(
      device.signMultisig({ wallet: impostor, psbt: forged, fingerprint: '4c00739d' }),
      /holds a different key at m\/48'\/0'\/0'\/2'/
    );
  });

  it('picks up where it left off on a new connection', async () => {
    await device.close();
    device = await open();
    await device.connect();
    assert.equal(prompts.pairingCodes.length, 1, 'still paired');
    assert.equal(await device.masterFingerprint(), '4c00739d');

    // And a phone the device has never met is asked to pair.
    const stranger = new RecordingPrompts();
    await device.close();
    device = new BitBox02Device(await TcpTransport.connect(PORT), {
      prompts: stranger,
      memory: new MapMemory(),
      testing: { skipAttestation: true },
    });
    await device.connect();
    assert.equal(stranger.pairingCodes.length, 1);
    assert.notEqual(stranger.pairingCodes[0], prompts.pairingCodes[0]);
  });
});

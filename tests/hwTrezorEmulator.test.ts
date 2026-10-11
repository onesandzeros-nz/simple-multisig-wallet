import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { accountXpub, bip32, bip48Path, btcNetwork, deriveAddress, masterFingerprint } from '../src/lib/bitcoin';
import { buildPsbt, finalizeAndExtract, signPsbtWithMnemonic, summarisePsbt } from '../src/lib/wallet';
import { MultisigWallet, NetworkName } from '../src/lib/types';
import { HardwareSignature, UserCancelled } from '../src/lib/hw/types';
import { TrezorDevice } from '../src/lib/hw/trezor';
import { DEST_MAINNET, MNEMONICS, makeFundedSnapshot, makeWallet } from './helpers';
import { Emulator, UdpTransport } from './hwTrezorHelpers';

/**
 * The driver against real Trezor firmware, running in the official emulator.
 *
 * Skipped unless TREZOR_EMULATOR says where one is listening, e.g.
 *   TREZOR_EMULATOR=127.0.0.1:21324 node --import tsx --test tests/hwTrezorEmulator.test.ts
 * and, for the one test that needs a Trezor Safe 7, TREZOR_EMULATOR_SAFE7.
 *
 * The emulator is wiped and loaded with a test seed — never point this at
 * anything that holds a real one. (Only an emulator has the debug link this
 * needs, so a real device would simply fail to answer.)
 */

const target = process.env.TREZOR_EMULATOR;
const [host, port] = (target ?? '').split(':');

const DEVICE_SEED = MNEMONICS[0];
const DEST_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const ConfirmOutput = 3;

/** A wallet whose first cosigner is the key the emulator holds. */
function walletWithDevice(m: number, network: NetworkName, deviceSeed = DEVICE_SEED): MultisigWallet {
  return makeWallet(m, [deviceSeed, MNEMONICS[1], MNEMONICS[2]], network);
}

function fundedPsbt(
  wallet: MultisigWallet,
  values: number[],
  amount: number,
  sendMax = false
): { psbt: bitcoin.Psbt; changeSats: number } {
  const { snapshot, transactions } = makeFundedSnapshot(wallet, values);
  const to = wallet.network === 'mainnet' ? DEST_MAINNET : DEST_TESTNET;
  const built = buildPsbt(wallet, snapshot, to, amount, 5, sendMax);
  built.psbt.txInputs.forEach((input, i) => {
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    built.psbt.updateInput(i, { nonWitnessUtxo: Buffer.from(transactions.get(txid)!, 'hex') });
  });
  return { psbt: built.psbt, changeSats: built.changeSats };
}

/** What the wallet engine would check before attaching a signature. */
function assertSignaturesValid(psbt: bitcoin.Psbt, wallet: MultisigWallet, signatures: HardwareSignature[]): void {
  const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
  const account = bip32.fromBase58(wallet.cosigners[0].xpub, btcNetwork(wallet.network));
  assert.equal(signatures.length, psbt.data.inputs.length);
  signatures.forEach((s, i) => {
    assert.equal(s.index, i);
    const input = psbt.data.inputs[i];
    const [branch, index] = input.bip32Derivation![0].path.split('/').slice(-2).map(Number);
    const expected = Buffer.from(account.derive(branch).derive(index).publicKey);
    assert.ok(expected.equals(s.pubkey), `input ${i} signed with the wallet's key`);
    assert.equal(s.signature.length, 64);
    const digest = tx.hashForWitnessV0(
      i,
      Buffer.from(input.witnessScript!),
      input.witnessUtxo!.value,
      bitcoin.Transaction.SIGHASH_ALL
    );
    assert.ok(ecc.verify(digest, s.pubkey, s.signature), `input ${i} signature verifies`);
  });
}

/** Adds the device's signatures and a second cosigner's, and proves the result is a valid spend. */
function finishTransaction(psbt: bitcoin.Psbt, wallet: MultisigWallet, signatures: HardwareSignature[]): string {
  for (const s of signatures) {
    psbt.updateInput(s.index, {
      partialSig: [
        {
          pubkey: s.pubkey,
          signature: bitcoin.script.signature.encode(s.signature, bitcoin.Transaction.SIGHASH_ALL),
        },
      ],
    });
  }
  assert.deepEqual(summarisePsbt(psbt, wallet).signedBy, [wallet.cosigners[0].fingerprint]);
  assert.equal(signPsbtWithMnemonic(psbt, MNEMONICS[1], wallet), psbt.data.inputs.length);
  assert.ok(summarisePsbt(psbt, wallet).complete);
  // Finalising checks every signature against the script once more.
  assert.ok(psbt.validateSignaturesOfAllInputs((pubkey, hash, signature) => ecc.verify(hash, pubkey, signature)));
  return finalizeAndExtract(psbt);
}

describe('Trezor driver against the emulator', { skip: !target, concurrency: false }, () => {
  let emulator: Emulator;

  const connect = async (): Promise<TrezorDevice> => {
    const device = new TrezorDevice(await emulator.transport(), {
      prompts: emulator.prompts,
      memory: { get: async () => null, set: async () => {} },
    });
    return device;
  };

  before(async () => {
    emulator = await Emulator.open({ host, port: Number(port) });
    await emulator.load({ mnemonic: DEVICE_SEED, label: 'Emulated' });
  });

  beforeEach(() => emulator.reset());

  after(async () => {
    await emulator?.close();
  });

  it('says what it is', async () => {
    const device = await connect();
    const info = await device.connect();
    console.log(`      ${info.model}, firmware ${info.firmware}`);
    assert.match(info.model, /^Trezor /);
    assert.match(info.firmware ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(info.label, 'Emulated');
    assert.equal(await device.masterFingerprint(), masterFingerprint(DEVICE_SEED));
    await device.close();
  });

  for (const network of ['mainnet', 'testnet'] as const) {
    it(`exports the BIP48 account key (${network})`, async () => {
      const device = await connect();
      await device.connect();
      const key = await device.getKey(network);
      assert.deepEqual(key, {
        xpub: accountXpub(DEVICE_SEED, network),
        fingerprint: masterFingerprint(DEVICE_SEED),
        path: bip48Path(network),
        network,
      });
      // Reading a key is silent: nothing to confirm on the device.
      assert.deepEqual(emulator.buttons, []);
      await device.close();
    });

    it(`signs a 2-of-3 spend with two inputs and change (${network})`, async () => {
      emulator.reset();
      const wallet = walletWithDevice(2, network);
      const { psbt, changeSats } = fundedPsbt(wallet, [60_000, 45_000], 80_000);
      assert.equal(psbt.data.inputs.length, 2);
      assert.ok(changeSats > 0, 'the transaction has a change output');

      const device = await connect();
      await device.connect();
      const signatures = await device.signMultisig({
        wallet,
        psbt,
        fingerprint: wallet.cosigners[0].fingerprint,
      });
      await device.close();

      assertSignaturesValid(psbt, wallet, signatures);
      const hex = finishTransaction(psbt, wallet, signatures);
      assert.equal(bitcoin.Transaction.fromHex(hex).ins.length, 2);
      console.log(`      buttons: ${emulator.buttons.join(',')}`);
    });
  }

  it('shows the payment but not the change', async () => {
    // The same payment twice: once with change, once without. If the device
    // recognises the change as the wallet's own, it asks about the same
    // number of outputs both times.
    const wallet = walletWithDevice(2, 'mainnet');
    const run = async (sendMax: boolean) => {
      emulator.reset();
      const { psbt } = fundedPsbt(wallet, [60_000, 45_000], 80_000, sendMax);
      assert.equal(psbt.txOutputs.length, sendMax ? 1 : 2);
      const device = await connect();
      await device.connect();
      const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
      await device.close();
      assertSignaturesValid(psbt, wallet, signatures);
      return emulator.buttons.filter((code) => code === ConfirmOutput).length;
    };
    const withChange = await run(false);
    const withoutChange = await run(true);
    assert.ok(withoutChange >= 1);
    assert.equal(withChange, withoutChange);
  });

  it('signs 3-of-5 with five inputs', async () => {
    const wallet = makeWallet(3, [MNEMONICS[1], MNEMONICS[2], DEVICE_SEED, MNEMONICS[3], MNEMONICS[4]], 'mainnet');
    const { snapshot, transactions } = makeFundedSnapshot(wallet, [20_000, 21_000, 22_000, 23_000, 24_000]);
    const built = buildPsbt(wallet, snapshot, DEST_MAINNET, 100_000, 3, false);
    built.psbt.txInputs.forEach((input, i) => {
      const txid = Buffer.from(input.hash).reverse().toString('hex');
      built.psbt.updateInput(i, { nonWitnessUtxo: Buffer.from(transactions.get(txid)!, 'hex') });
    });
    assert.equal(built.psbt.data.inputs.length, 5);

    const device = await connect();
    await device.connect();
    const fingerprint = masterFingerprint(DEVICE_SEED);
    const signatures = await device.signMultisig({ wallet, psbt: built.psbt, fingerprint });
    await device.close();

    const tx = bitcoin.Transaction.fromBuffer((built.psbt.data.globalMap.unsignedTx as any).toBuffer());
    for (const s of signatures) {
      const input = built.psbt.data.inputs[s.index];
      const digest = tx.hashForWitnessV0(
        s.index,
        Buffer.from(input.witnessScript!),
        input.witnessUtxo!.value,
        bitcoin.Transaction.SIGHASH_ALL
      );
      assert.ok(ecc.verify(digest, s.pubkey, s.signature));
      built.psbt.updateInput(s.index, {
        partialSig: [
          { pubkey: s.pubkey, signature: bitcoin.script.signature.encode(s.signature, bitcoin.Transaction.SIGHASH_ALL) },
        ],
      });
    }
    signPsbtWithMnemonic(built.psbt, MNEMONICS[1], wallet);
    signPsbtWithMnemonic(built.psbt, MNEMONICS[4], wallet);
    assert.ok(summarisePsbt(built.psbt, wallet).complete);
    finalizeAndExtract(built.psbt);
  });

  it('spends change and received coins together, from funding transactions with witnesses', async () => {
    const wallet = walletWithDevice(2, 'testnet');
    // Two coins the wallet received in busy segwit transactions: one on the
    // receive branch, one that was change.
    const coins = ([[0, 3, 70_000], [1, 2, 55_000]] as const).map(([branch, index, value], n) => {
      const derived = deriveAddress(wallet, branch, index);
      const funding = new bitcoin.Transaction();
      funding.version = 1;
      funding.locktime = 500_000 + n;
      for (let i = 0; i < 3; i++) {
        funding.addInput(Buffer.alloc(32, 40 + n * 10 + i), i, 0xfffffffe, i === 1 ? Buffer.from('160014' + '11'.repeat(20), 'hex') : Buffer.alloc(0));
        funding.setWitness(i, [Buffer.alloc(71, 3), Buffer.alloc(33, 2)]);
      }
      for (let i = 0; i < 4; i++) {
        funding.addOutput(i === 2 ? derived.script : bitcoin.address.toOutputScript(DEST_TESTNET, bitcoin.networks.testnet), i === 2 ? value : 1_000 + i);
      }
      assert.ok(funding.hasWitnesses());
      return { funding, utxo: { txid: funding.getId(), vout: 2, value, address: derived.address, branch, index, confirmed: true } };
    });
    const snapshot = {
      confirmedSats: 125_000,
      unconfirmedSats: 0,
      utxos: coins.map((c) => c.utxo),
      usedAddresses: [],
      nextReceiveIndex: 4,
      nextChangeIndex: 3,
      scannedAt: 0,
    };
    const { psbt, changeSats } = buildPsbt(wallet, snapshot, DEST_TESTNET, 100_000, 4, false);
    assert.ok(changeSats > 0);
    psbt.setLocktime(2_500_000);
    psbt.txInputs.forEach((input, i) => {
      const coin = coins.find((c) => c.utxo.txid === Buffer.from(input.hash).reverse().toString('hex'))!;
      psbt.updateInput(i, { nonWitnessUtxo: coin.funding.toBuffer() });
    });

    const device = await connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    await device.close();
    assertSignaturesValid(psbt, wallet, signatures);
    const tx = bitcoin.Transaction.fromHex(finishTransaction(psbt, wallet, signatures));
    assert.equal(tx.locktime, 2_500_000);
  });

  it('shows an output that only claims to be change', async () => {
    const wallet = walletWithDevice(2, 'mainnet');
    const honest = async () => {
      emulator.reset();
      const { psbt } = fundedPsbt(wallet, [60_000, 45_000], 80_000);
      const device = await connect();
      await device.connect();
      await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
      await device.close();
      return { psbt, shown: emulator.buttons.filter((code) => code === ConfirmOutput).length };
    };
    const { psbt, shown } = await honest();

    // The same transaction, its change swapped for someone else's address
    // while keeping every label that says it is this wallet's.
    const attacker = makeWallet(2, [MNEMONICS[3], MNEMONICS[4], MNEMONICS[1]], 'mainnet');
    const theft = new bitcoin.Psbt();
    theft.setVersion(2);
    psbt.txInputs.forEach((input, i) => {
      const { partialSig, ...details } = psbt.data.inputs[i];
      theft.addInput({ hash: input.hash, index: input.index, sequence: input.sequence, ...details });
    });
    theft.addOutput({ address: DEST_MAINNET, value: 80_000 });
    theft.addOutput({
      script: deriveAddress(attacker, 1, 0).script,
      value: psbt.txOutputs[1].value,
      bip32Derivation: psbt.data.outputs[1].bip32Derivation,
      witnessScript: psbt.data.outputs[1].witnessScript,
    });

    emulator.reset();
    const device = await connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt: theft, fingerprint: wallet.cosigners[0].fingerprint });
    await device.close();
    assertSignaturesValid(theft, wallet, signatures);
    assert.equal(emulator.buttons.filter((code) => code === ConfirmOutput).length, shown * 2);
  });

  it('shows a payment to one of the wallet’s own receive addresses', async () => {
    const wallet = walletWithDevice(2, 'mainnet');
    const own = deriveAddress(wallet, 0, 9);
    const { snapshot, transactions } = makeFundedSnapshot(wallet, [60_000]);
    const { psbt } = buildPsbt(wallet, snapshot, own.address, 30_000, 5, false);
    psbt.updateInput(0, {
      nonWitnessUtxo: Buffer.from(transactions.get(Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex'))!, 'hex'),
    });
    psbt.updateOutput(0, { bip32Derivation: own.derivations, witnessScript: own.witnessScript });
    const device = await connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    await device.close();
    assertSignaturesValid(psbt, wallet, signatures);
    assert.ok(emulator.buttons.includes(ConfirmOutput));
  });

  it('signs from an account that is not the first', async () => {
    const path = "m/48'/0'/5'/2'";
    const seed = bip39.mnemonicToSeedSync(DEVICE_SEED);
    const xpub = bip32.fromSeed(seed, bitcoin.networks.bitcoin).derivePath(path).neutered().toBase58();
    const wallet = walletWithDevice(2, 'mainnet');
    wallet.cosigners[0] = { ...wallet.cosigners[0], path, xpub };
    const { psbt } = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const device = await connect();
    await device.connect();
    assert.equal((await device.getKey('mainnet', path)).xpub, xpub);
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    await device.close();
    assertSignaturesValid(psbt, wallet, signatures);
    finishTransaction(psbt, wallet, signatures);
  });

  it('reports a refusal on the device as a cancellation, and carries on afterwards', async () => {
    const wallet = walletWithDevice(2, 'mainnet');
    const { psbt } = fundedPsbt(wallet, [60_000], 30_000);
    emulator.policy = 'reject';
    const device = await connect();
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      (e: any) => e instanceof UserCancelled
    );
    emulator.policy = 'confirm';
    await emulator.settled();
    // The same connection is still good.
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    assertSignaturesValid(psbt, wallet, signatures);
    await device.close();
  });

  it('refuses to sign for a wallet whose key it does not hold', async () => {
    const wallet = makeWallet(2, [MNEMONICS[1], MNEMONICS[2], MNEMONICS[3]], 'mainnet');
    const { psbt } = fundedPsbt(wallet, [60_000], 30_000);
    emulator.reset();
    const device = await connect();
    await device.connect();
    await assert.rejects(
      device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /different key/
    );
    assert.deepEqual(emulator.buttons, [], 'the device was never asked to sign');
    await device.close();
  });

  it('asks for the PIN', async () => {
    await emulator.load({ mnemonic: DEVICE_SEED, pin: '1234' });
    await emulator.lock();
    const device = await connect();
    await device.connect();
    assert.equal(await device.masterFingerprint(), masterFingerprint(DEVICE_SEED));
    if (emulator.isModelOne) assert.equal(emulator.pinPrompts, 1, 'the PIN was asked for on the phone');
    else assert.ok(emulator.buttons.includes(20), 'the PIN was asked for on the device');
    assert.ok(emulator.statuses.length > 0, 'the phone said what the device was waiting for');
    await device.close();
  });

  it('says so when the PIN typed on the phone is wrong', async (t) => {
    // A device with a screen of its own simply asks again, there.
    if (!emulator.isModelOne) return t.skip('only the Model One takes its PIN on the phone');
    await emulator.load({ mnemonic: DEVICE_SEED, pin: '1234' });
    await emulator.lock();
    emulator.pin = '4321';
    {
      const device = await connect();
      await assert.rejects(device.connect(), /Wrong PIN/);
      await device.close();
    }
    emulator.pin = '1234';
    {
      const device = await connect();
      await device.connect();
      await device.close();
    }
  });

  it('leaves the device usable when the PIN prompt is cancelled on the phone', async (t) => {
    if (!emulator.isModelOne) return t.skip('only the Model One takes its PIN on the phone');
    await emulator.load({ mnemonic: DEVICE_SEED, pin: '1234' });
    await emulator.lock();
    emulator.cancelPrompts = true;
    const device = await connect();
    await assert.rejects(device.connect(), (e: any) => e instanceof UserCancelled);
    await device.close();
    emulator.cancelPrompts = false;
    const again = await connect();
    await again.connect();
    await again.close();
  });

  it('opens the passphrase wallet typed on the phone', async () => {
    await emulator.load({ mnemonic: DEVICE_SEED, passphraseProtection: true });
    emulator.hostPassphrase = 'correct horse';
    const seed = bip39.mnemonicToSeedSync(DEVICE_SEED, 'correct horse');
    const root = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
    const device = await connect();
    await device.connect();
    assert.equal(emulator.passphrasePrompts, 1);
    assert.equal(await device.masterFingerprint(), Buffer.from(root.fingerprint).toString('hex'));
    const key = await device.getKey('mainnet');
    assert.equal(key.xpub, root.derivePath(bip48Path('mainnet')).neutered().toBase58());
    // Asked once per connection, not once per request.
    assert.equal(emulator.passphrasePrompts, 1);
    await device.close();

    // The empty passphrase is the plain wallet.
    emulator.reset();
    emulator.hostPassphrase = '';
    const plain = await connect();
    await plain.connect();
    assert.equal(await plain.masterFingerprint(), masterFingerprint(DEVICE_SEED));
    await plain.close();
  });

  it('opens the passphrase wallet typed on the device', async (t) => {
    if (emulator.isModelOne) return t.skip('the Model One has no keyboard');
    await emulator.load({ mnemonic: DEVICE_SEED, passphraseProtection: true });
    emulator.hostPassphrase = null;
    emulator.devicePassphrase = 'on device';
    const root = bip32.fromSeed(bip39.mnemonicToSeedSync(DEVICE_SEED, 'on device'), bitcoin.networks.bitcoin);
    const device = await connect();
    await device.connect();
    assert.equal(await device.masterFingerprint(), Buffer.from(root.fingerprint).toString('hex'));
    await device.close();
  });

  it('calls off a confirmation left waiting when the connection is closed', async () => {
    await emulator.load({ mnemonic: DEVICE_SEED });
    const wallet = walletWithDevice(2, 'mainnet');
    const { psbt } = fundedPsbt(wallet, [60_000], 30_000);
    emulator.policy = 'ignore';
    const device = await connect();
    await device.connect();
    const signing = device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    const outcome = assert.rejects(signing);
    // Wait until the device is showing its question.
    for (let i = 0; i < 100 && emulator.buttons.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(emulator.buttons.length > 0);
    await device.close();
    await outcome;
    emulator.policy = 'confirm';

    // A new connection finds the device at rest, not stuck on the old screen.
    const again = await connect();
    await again.connect();
    const signatures = await again.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    assertSignaturesValid(psbt, wallet, signatures);
    await again.close();
  });

  it('takes over a device that another host left waiting on a confirmation', async () => {
    await emulator.load({ mnemonic: DEVICE_SEED });
    const wallet = walletWithDevice(2, 'mainnet');
    const { psbt } = fundedPsbt(wallet, [60_000], 30_000);
    emulator.policy = 'ignore';
    const transport = await emulator.transport();
    const abandoned = new TrezorDevice(transport, {
      prompts: emulator.prompts,
      memory: { get: async () => null, set: async () => {} },
    });
    await abandoned.connect();
    const outcome = assert.rejects(
      abandoned.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint })
    );
    for (let i = 0; i < 100 && emulator.buttons.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(emulator.buttons.length > 0);
    // The host vanishes: no cancellation, no goodbye. The question stays on the screen.
    await transport.close();
    await outcome;
    emulator.policy = 'confirm';

    const device = await connect();
    await device.connect();
    const signatures = await device.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    assertSignaturesValid(psbt, wallet, signatures);
    await device.close();
  });
});

describe('Trezor Safe 7 emulator', { skip: !process.env.TREZOR_EMULATOR_SAFE7 }, () => {
  it('is recognised and turned away at once', async () => {
    const [safe7Host, safe7Port] = process.env.TREZOR_EMULATOR_SAFE7!.split(':');
    const transport = await UdpTransport.open(safe7Host, Number(safe7Port));
    assert.ok(await transport.ping(10_000), 'the Safe 7 emulator is answering');
    const statuses: string[] = [];
    const device = new TrezorDevice(transport, {
      prompts: {
        status: (message) => statuses.push(message),
        pinMatrix: async () => assert.fail('never asked'),
        passphrase: async () => assert.fail('never asked'),
        confirmPairing: async () => assert.fail('never asked'),
      },
      memory: { get: async () => null, set: async () => {} },
    });
    const started = Date.now();
    await assert.rejects(device.connect(), /Safe 7.*cannot use over USB yet/);
    assert.ok(Date.now() - started < 2_000, 'it did not wait for a timeout to find out');
    assert.deepEqual(statuses, []);
    await device.close();
  });
});

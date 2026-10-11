import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { bip48Path, masterFingerprint, rootFromMnemonic } from '../src/lib/bitcoin';
import {
  buildPsbt,
  finalizeAndExtract,
  parsePsbt,
  signPsbtWithMnemonic,
  summarisePsbt,
} from '../src/lib/wallet';
import { MultisigWallet, NetworkName } from '../src/lib/types';
import {
  DeviceInfo,
  HardwareDevice,
  HardwareKey,
  HardwareSignature,
  MultisigSignRequest,
  TransportTimeout,
} from '../src/lib/hw/types';
import {
  cosignerForDevice,
  readKeyFromDevice,
  signPsbtWithDevice,
  withPreviousTransactions,
} from '../src/lib/hw/sign';
import { identifyDevice, identifyDevices, isHardwareKind, kindName } from '../src/lib/hw/devices';
import { PacketQueue } from '../src/lib/hw/packetQueue';
import { describeUsbError } from '../src/lib/hw/usbErrors';
import type { UsbDeviceDescription, UsbInterfaceDescription } from '../modules/usb-host/src/UsbHost.types';
import { DEST_MAINNET, MNEMONICS, makeFundedSnapshot, makeWallet, withVersionBytes } from './helpers';

/**
 * Stands in for any of the three devices: it holds a seed and signs what it is
 * shown, the way a real one does once its owner has pressed the button.
 */
class FakeDevice implements HardwareDevice {
  readonly kind = 'trezor' as const;
  /** What the device was shown, for the tests to inspect. */
  shown: MultisigSignRequest | null = null;
  keyReads = 0;
  tamper: (signatures: HardwareSignature[]) => HardwareSignature[] = (s) => s;
  keyOverride: ((key: HardwareKey) => HardwareKey) | null = null;

  constructor(private mnemonic: string) {}

  async connect(): Promise<DeviceInfo> {
    return { model: 'Fake' };
  }

  async masterFingerprint(): Promise<string> {
    return masterFingerprint(this.mnemonic);
  }

  async getKey(network: NetworkName, path: string = bip48Path(network)): Promise<HardwareKey> {
    this.keyReads++;
    const xpub = rootFromMnemonic(this.mnemonic, network).derivePath(path).neutered().toBase58();
    const key = { xpub, fingerprint: masterFingerprint(this.mnemonic), path, network };
    return this.keyOverride ? this.keyOverride(key) : key;
  }

  async signMultisig(request: MultisigSignRequest): Promise<HardwareSignature[]> {
    this.shown = request;
    const { psbt, wallet, fingerprint } = request;
    const root = rootFromMnemonic(this.mnemonic, wallet.network);
    const tx = bitcoin.Transaction.fromBuffer((psbt.data.globalMap.unsignedTx as any).toBuffer());
    const out: HardwareSignature[] = [];
    psbt.data.inputs.forEach((input, index) => {
      const mine = input.bip32Derivation!.find(
        (d) => Buffer.from(d.masterFingerprint).toString('hex') === fingerprint
      );
      if (!mine) return;
      const node = root.derivePath(mine.path);
      const digest = tx.hashForWitnessV0(
        index,
        Buffer.from(input.witnessScript!),
        input.witnessUtxo!.value,
        bitcoin.Transaction.SIGHASH_ALL
      );
      out.push({
        index,
        pubkey: Buffer.from(node.publicKey),
        signature: Buffer.from(ecc.sign(digest, node.privateKey!)),
      });
    });
    return this.tamper(out);
  }

  async close(): Promise<void> {}
}

function draft(wallet: MultisigWallet, values = [60_000, 50_000], amount = 80_000) {
  const { snapshot, transactions } = makeFundedSnapshot(wallet, values);
  const built = buildPsbt(wallet, snapshot, DEST_MAINNET, amount, 5, false);
  const fetchTx = async (_network: NetworkName, txid: string) => {
    const hex = transactions.get(txid);
    if (!hex) throw new Error('404');
    return hex;
  };
  return { base64: built.psbt.toBase64(), fetchTx, transactions, built };
}

describe('signing with a hardware wallet', () => {
  const mnemonics = MNEMONICS.slice(0, 3);
  const wallet = makeWallet(2, mnemonics);

  it('adds the device’s signatures, and the transaction then finalises', async () => {
    const { base64, fetchTx, built } = draft(wallet);
    assert.equal(built.usedUtxos.length, 2, 'the draft should spend two coins');
    assert.ok(built.changeSats > 0, 'the draft should have change');

    const device = new FakeDevice(mnemonics[1]);
    const result = await signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx });

    assert.equal(result.cosigner.fingerprint, masterFingerprint(mnemonics[1]));
    assert.equal(result.signedInputs, 2);
    const signed = parsePsbt(result.base64, 'mainnet');
    assert.deepEqual(summarisePsbt(signed, wallet).signedBy, [masterFingerprint(mnemonics[1])]);

    // A second cosigner on the phone completes it.
    assert.equal(signPsbtWithMnemonic(signed, mnemonics[0], wallet), 2);
    const tx = bitcoin.Transaction.fromHex(finalizeAndExtract(signed));
    assert.equal(tx.ins.length, 2);
  });

  it('shows the device the previous transactions but does not keep them', async () => {
    const { base64, fetchTx, transactions } = draft(wallet);
    const device = new FakeDevice(mnemonics[0]);
    const result = await signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx });

    for (const input of device.shown!.psbt.data.inputs) {
      const previous = bitcoin.Transaction.fromBuffer(Buffer.from(input.nonWitnessUtxo!));
      assert.ok(transactions.has(previous.getId()));
    }
    // The stored copy travels by QR and relay; it must not grow.
    for (const input of parsePsbt(result.base64, 'mainnet').data.inputs) {
      assert.equal(input.nonWitnessUtxo, undefined);
    }
  });

  it('refuses a device whose key is not in the wallet, before showing it anything', async () => {
    const { base64, fetchTx } = draft(wallet);
    const stranger = new FakeDevice(MNEMONICS[4]);
    await assert.rejects(
      signPsbtWithDevice({ device: stranger, wallet, psbtBase64: base64, fetchTx }),
      /not one of the 3 keys/
    );
    assert.equal(stranger.shown, null);
  });

  it('refuses the wrong device when a particular cosigner was asked for', async () => {
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    await assert.rejects(
      signPsbtWithDevice({
        device,
        wallet,
        psbtBase64: base64,
        fetchTx,
        expectFingerprint: masterFingerprint(mnemonics[2]),
      }),
      /different key.*Signer 3/s
    );
    assert.equal(device.shown, null);
  });

  it('does not take a fingerprint as proof of the key', async () => {
    // Same fingerprint, different account key: a passphrase wallet, a wrong
    // account, or a wallet file that lies about whose key it holds.
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    const other = rootFromMnemonic(MNEMONICS[4], 'mainnet').derivePath(bip48Path('mainnet')).neutered().toBase58();
    device.keyOverride = (key) => ({ ...key, xpub: other });
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx }),
      /different key at m\/48'\/0'\/0'\/2'/
    );
    assert.equal(device.shown, null);
  });

  it('has nothing to ask of a device that already signed', async () => {
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    const once = await signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx });
    device.shown = null;
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: once.base64, fetchTx }),
      /already signed/
    );
    assert.equal(device.shown, null);
  });

  it('refuses a signature made with another key', async () => {
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    const impostor = rootFromMnemonic(MNEMONICS[4], 'mainnet').derivePath("m/48'/0'/0'/2'/0/0");
    device.tamper = (sigs) =>
      sigs.map((s, i) => (i === 0 ? { ...s, pubkey: Buffer.from(impostor.publicKey) } : s));
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx }),
      /different key from the one this wallet expects/
    );
  });

  it('refuses a signature that does not verify', async () => {
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    // Signatures for the two inputs, swapped: each is genuine, for the other input.
    device.tamper = (sigs) => [
      { ...sigs[0], signature: sigs[1].signature },
      { ...sigs[1], signature: sigs[0].signature },
    ];
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx }),
      /does not match this transaction/
    );
  });

  it('refuses a partial or malformed answer', async () => {
    const { base64, fetchTx } = draft(wallet);
    const device = new FakeDevice(mnemonics[1]);
    device.tamper = (sigs) => sigs.slice(0, 1);
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx }),
      /did not sign input 1/
    );
    device.tamper = (sigs) => sigs.map((s) => ({ ...s, signature: Buffer.alloc(70, 1) }));
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: base64, fetchTx }),
      /malformed signature/
    );
  });

  it('will not send a device coins the wallet cannot account for', async () => {
    const { base64, fetchTx } = draft(wallet);
    const psbt = parsePsbt(base64, 'mainnet');
    // Claim the first input sits at an address the wallet would never derive there.
    const foreign = makeWallet(2, [MNEMONICS[3], MNEMONICS[4]]);
    const theirs = makeFundedSnapshot(foreign, [70_000]);
    const mixed = buildPsbt(foreign, theirs.snapshot, DEST_MAINNET, 30_000, 5, false).psbt;
    psbt.data.inputs[0].witnessUtxo = mixed.data.inputs[0].witnessUtxo;
    const device = new FakeDevice(mnemonics[1]);
    await assert.rejects(
      signPsbtWithDevice({ device, wallet, psbtBase64: psbt.toBase64(), fetchTx }),
      /not from this wallet/
    );
    assert.equal(device.shown, null);
  });

  it('works on testnet', async () => {
    const testWallet = makeWallet(2, mnemonics, 'testnet');
    const { snapshot, transactions } = makeFundedSnapshot(testWallet, [90_000]);
    const dest = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const base64 = buildPsbt(testWallet, snapshot, dest, 40_000, 3, false).psbt.toBase64();
    const device = new FakeDevice(mnemonics[2]);
    const result = await signPsbtWithDevice({
      device,
      wallet: testWallet,
      psbtBase64: base64,
      fetchTx: async (_n, txid) => transactions.get(txid)!,
    });
    const signed = parsePsbt(result.base64, 'testnet');
    signPsbtWithMnemonic(signed, mnemonics[0], testWallet);
    assert.ok(finalizeAndExtract(signed).length > 0);
  });
});

describe('previous transactions', () => {
  const wallet = makeWallet(2, MNEMONICS.slice(0, 3));

  it('refuses a transaction other than the one asked for', async () => {
    const { base64, transactions } = draft(wallet);
    const psbt = parsePsbt(base64, 'mainnet');
    const [first, second] = [...transactions.values()];
    // The server answers every request with the same transaction.
    await assert.rejects(
      withPreviousTransactions(psbt, 'mainnet', async () => first),
      /different transaction/
    );
    assert.notEqual(first, second);
  });

  it('refuses an input whose claimed amount is not what the chain says', async () => {
    const { base64, fetchTx } = draft(wallet);
    const psbt = parsePsbt(base64, 'mainnet');
    // The fee-inflation attack previous transactions exist to stop.
    psbt.data.inputs[0].witnessUtxo = {
      script: psbt.data.inputs[0].witnessUtxo!.script,
      value: psbt.data.inputs[0].witnessUtxo!.value - 10_000,
    };
    await assert.rejects(withPreviousTransactions(psbt, 'mainnet', fetchTx), /amount or address is wrong/);
  });

  it('refuses an input pointing past the end of its transaction', async () => {
    const { snapshot, transactions } = makeFundedSnapshot(wallet, [60_000]);
    snapshot.utxos[0].vout = 7;
    const psbt = buildPsbt(wallet, snapshot, DEST_MAINNET, 20_000, 5, false).psbt;
    await assert.rejects(
      withPreviousTransactions(psbt, 'mainnet', async (_n, txid) => transactions.get(txid)!),
      /does not have/
    );
  });

  it('refuses garbage, and explains a server that cannot be reached', async () => {
    const { base64 } = draft(wallet);
    await assert.rejects(
      withPreviousTransactions(parsePsbt(base64, 'mainnet'), 'mainnet', async () => 'not hex'),
      /malformed/
    );
    await assert.rejects(
      withPreviousTransactions(parsePsbt(base64, 'mainnet'), 'mainnet', async () => 'abcd'),
      /could not be read/
    );
    await assert.rejects(
      withPreviousTransactions(parsePsbt(base64, 'mainnet'), 'mainnet', async () => {
        throw new Error('Network error (503)');
      }),
      /Could not fetch.*503/s
    );
  });

  it('asks once for a transaction two inputs spend from', async () => {
    // One transaction paying the wallet twice.
    const a = makeFundedSnapshot(wallet, [60_000, 50_000]);
    const funding = new bitcoin.Transaction();
    funding.version = 2;
    funding.addInput(Buffer.alloc(32, 9), 0, 0xfffffffd, Buffer.alloc(0));
    for (const u of a.snapshot.utxos) {
      funding.addOutput(bitcoin.address.toOutputScript(u.address, bitcoin.networks.bitcoin), u.value);
    }
    a.snapshot.utxos.forEach((u, i) => {
      u.txid = funding.getId();
      u.vout = i;
    });
    const psbt = buildPsbt(wallet, a.snapshot, DEST_MAINNET, 80_000, 5, false).psbt;
    let asked = 0;
    await withPreviousTransactions(psbt, 'mainnet', async () => {
      asked++;
      return funding.toHex();
    });
    assert.equal(asked, 1);
    assert.equal(psbt.data.inputs.length, 2);
    assert.ok(psbt.data.inputs.every((i) => i.nonWitnessUtxo));
  });

  it('checks a previous transaction the draft already carried', async () => {
    const { base64, transactions } = draft(wallet);
    const psbt = parsePsbt(base64, 'mainnet');
    const [first] = [...transactions.values()];
    psbt.updateInput(0, { nonWitnessUtxo: Buffer.from(first, 'hex') });
    let asked = 0;
    await withPreviousTransactions(psbt, 'mainnet', async (_n, txid) => {
      asked++;
      return transactions.get(txid)!;
    });
    assert.equal(asked, 1, 'only the input without one is fetched');
  });
});

describe('reading a key from a device', () => {
  it('returns the account key at the BIP48 path', async () => {
    const device = new FakeDevice(MNEMONICS[0]);
    const key = await readKeyFromDevice(device, 'mainnet');
    assert.equal(key.path, "m/48'/0'/0'/2'");
    assert.equal(key.fingerprint, masterFingerprint(MNEMONICS[0]));
    assert.ok(key.xpub.startsWith('xpub'));
    const test = await readKeyFromDevice(device, 'testnet');
    assert.equal(test.path, "m/48'/1'/0'/2'");
    assert.ok(test.xpub.startsWith('tpub'));
  });

  it('normalises a SLIP-132 key and a shouted fingerprint', async () => {
    const device = new FakeDevice(MNEMONICS[0]);
    const plain = (await device.getKey('mainnet')).xpub;
    device.keyOverride = (key) => ({
      ...key,
      xpub: withVersionBytes(key.xpub, '02aa7ed3'), // Zpub
      fingerprint: key.fingerprint.toUpperCase(),
    });
    const key = await readKeyFromDevice(device, 'mainnet');
    assert.equal(key.xpub, plain);
    assert.equal(key.fingerprint, masterFingerprint(MNEMONICS[0]));
  });

  it('refuses a key for the wrong network, or without a fingerprint', async () => {
    const device = new FakeDevice(MNEMONICS[0]);
    const testnetKey = (await device.getKey('testnet')).xpub;
    device.keyOverride = (key) => ({ ...key, xpub: testnetKey });
    await assert.rejects(readKeyFromDevice(device, 'mainnet'), /returned a testnet key/);
    device.keyOverride = (key) => ({ ...key, fingerprint: '' });
    await assert.rejects(readKeyFromDevice(device, 'mainnet'), /no master fingerprint/);
  });

  it('finds the cosigner a device holds', async () => {
    const wallet = makeWallet(2, MNEMONICS.slice(0, 3));
    const cosigner = await cosignerForDevice(new FakeDevice(MNEMONICS[2]), wallet);
    assert.equal(cosigner.name, 'Signer 3');
  });
});

// ---------------------------------------------------------------------------

const HID = 3;
const VENDOR = 0xff;

function iface(index: number, usbClass: number, directions: ('in' | 'out')[] = ['in', 'out']): UsbInterfaceDescription {
  return {
    index,
    number: index,
    class: usbClass,
    subclass: 0,
    protocol: 0,
    endpoints: directions.map((direction, i) => ({
      address: direction === 'in' ? 0x81 + index : 0x01 + index + i,
      direction,
      type: 'interrupt',
      maxPacketSize: 64,
    })),
  };
}

function usb(
  vendorId: number,
  productId: number,
  productName: string | null,
  interfaces: UsbInterfaceDescription[]
): UsbDeviceDescription {
  return {
    id: '/dev/bus/usb/001/002',
    vendorId,
    productId,
    productName,
    manufacturerName: null,
    hasPermission: false,
    interfaces,
  };
}

describe('recognising devices', () => {
  it('names Ledger models from the product id, whatever app is open', () => {
    const dashboard = identifyDevice(usb(0x2c97, 0x5011, 'Nano S Plus', [iface(0, HID), iface(1, VENDOR)]));
    assert.deepEqual(
      { kind: dashboard?.kind, model: dashboard?.model, interfaceIndex: dashboard?.interfaceIndex },
      { kind: 'ledger', model: 'Ledger Nano S Plus', interfaceIndex: 0 }
    );
    assert.equal(identifyDevice(usb(0x2c97, 0x4015, null, [iface(0, HID)]))?.model, 'Ledger Nano X');
    assert.equal(identifyDevice(usb(0x2c97, 0x1011, null, [iface(0, HID)]))?.model, 'Ledger Nano S');
    assert.equal(identifyDevice(usb(0x2c97, 0x6011, null, [iface(0, HID)]))?.model, 'Ledger Stax');
    assert.equal(identifyDevice(usb(0x2c97, 0x7011, null, [iface(0, HID)]))?.model, 'Ledger Flex');
    assert.equal(identifyDevice(usb(0x2c97, 0x0001, null, [iface(0, HID)]))?.model, 'Ledger Nano S');
    assert.equal(identifyDevice(usb(0x2c97, 0x9911, null, [iface(0, HID)]))?.model, 'Ledger');
  });

  it('opens a Trezor’s wallet interface, not its FIDO one', () => {
    const safe = identifyDevice(usb(0x1209, 0x53c1, 'TREZOR', [iface(0, VENDOR), iface(1, HID)]));
    assert.equal(safe?.kind, 'trezor');
    assert.equal(safe?.interfaceIndex, 0);
    assert.equal(safe?.bootloader, false);
    // FIDO listed first must not win.
    const reordered = identifyDevice(usb(0x1209, 0x53c1, 'TREZOR', [iface(0, HID), iface(1, VENDOR)]));
    assert.equal(reordered?.interfaceIndex, 1);
  });

  it('falls back to HID for a Model One on old firmware', () => {
    const one = identifyDevice(usb(0x534c, 0x0001, 'TREZOR', [iface(0, HID), iface(1, HID)]));
    assert.equal(one?.kind, 'trezor');
    assert.equal(one?.model, 'Trezor Model One');
    assert.equal(one?.interfaceIndex, 0);
  });

  it('flags a Trezor in bootloader mode', () => {
    assert.equal(identifyDevice(usb(0x1209, 0x53c0, 'TREZOR', [iface(0, VENDOR)]))?.bootloader, true);
  });

  it('knows a BitBox02 by name as well as number', () => {
    const multi = identifyDevice(usb(0x03eb, 0x2403, 'BitBox02', [iface(0, HID), iface(1, HID)]));
    assert.deepEqual(
      { kind: multi?.kind, model: multi?.model, interfaceIndex: multi?.interfaceIndex, bootloader: multi?.bootloader },
      { kind: 'bitbox02', model: 'BitBox02', interfaceIndex: 0, bootloader: false }
    );
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, 'BitBox02BTC', [iface(0, HID)]))?.kind, 'bitbox02');
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, 'bb02-bootloader', [iface(0, HID)]))?.bootloader, true);
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, 'bb02btc-bootloader', [iface(0, HID)]))?.bootloader, true);
    const nova = identifyDevice(usb(0x03eb, 0x2403, 'BitBox02 Nova BTC-only', [iface(0, HID)]));
    assert.deepEqual({ model: nova?.model, bootloader: nova?.bootloader }, { model: 'BitBox02 Nova', bootloader: false });
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, 'BitBox02 Nova Multi bl', [iface(0, HID)]))?.bootloader, true);
    // The vendor id is the chip maker's: plenty of other things carry it.
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, 'Some Dev Board', [iface(0, HID)])), null);
    assert.equal(identifyDevice(usb(0x03eb, 0x2403, null, [iface(0, HID)])), null);
    assert.equal(identifyDevice(usb(0x03eb, 0x2ff4, 'BitBox02', [iface(0, HID)])), null);
  });

  it('ignores everything else, and interfaces it could not talk over', () => {
    assert.equal(identifyDevice(usb(0x046d, 0xc52b, 'USB Receiver', [iface(0, HID)])), null);
    assert.equal(identifyDevice(usb(0x1209, 0x0001, 'Something on pid.codes', [iface(0, VENDOR)])), null);
    // Read-only interface: nowhere to send a command.
    assert.equal(identifyDevice(usb(0x2c97, 0x5011, null, [iface(0, HID, ['in'])])), null);
    assert.equal(identifyDevice(usb(0x2c97, 0x5011, null, [])), null);
  });

  it('carries the phone’s handle and permission through', () => {
    const found = identifyDevices([
      { ...usb(0x2c97, 0x5011, null, [iface(0, HID)]), id: 'a', hasPermission: true },
      usb(0x046d, 0xc52b, 'Mouse', [iface(0, HID)]),
      { ...usb(0x1209, 0x53c1, null, [iface(0, VENDOR)]), id: 'b' },
    ]);
    assert.deepEqual(
      found.map((f) => [f.id, f.kind, f.hasPermission]),
      [
        ['a', 'ledger', true],
        ['b', 'trezor', false],
      ]
    );
  });

  it('names the kinds', () => {
    assert.equal(kindName('bitbox02'), 'BitBox02');
    assert.ok(isHardwareKind('ledger'));
    assert.ok(!isHardwareKind('tapsigner'));
    assert.ok(!isHardwareKind(undefined));
  });
});

describe('USB errors', () => {
  it('keeps the cause and drops the plumbing around it', () => {
    const wrapped = new Error(
      "Call to function 'UsbHost.open' has been rejected.\n→ Caused by: Another app is using the USB device. Close it and try again."
    );
    assert.equal(describeUsbError(wrapped).message, 'Another app is using the USB device. Close it and try again.');
    assert.equal(describeUsbError(new Error('The USB device was unplugged.')).message, 'The USB device was unplugged.');
  });

  it('never comes back empty', () => {
    assert.match(describeUsbError(new Error('')).message, /unknown reason/);
    assert.match(describeUsbError(undefined).message, /unknown reason/);
    assert.equal(describeUsbError('plain text').message, 'plain text');
  });
});

describe('packet queue', () => {
  const packet = (n: number) => Uint8Array.from([n]);

  it('hands packets over in the order they arrived', async () => {
    const q = new PacketQueue();
    q.push(packet(1));
    q.push(packet(2));
    assert.deepEqual([...(await q.read(10))], [1]);
    assert.deepEqual([...(await q.read(10))], [2]);
  });

  it('wakes a read that was already waiting', async () => {
    const q = new PacketQueue();
    const reading = q.read(1000);
    q.push(packet(7));
    assert.deepEqual([...(await reading)], [7]);
  });

  it('times out without losing what arrives late', async () => {
    const q = new PacketQueue();
    await assert.rejects(q.read(5), (e: Error) => e instanceof TransportTimeout);
    q.push(packet(3));
    assert.deepEqual([...(await q.read(5))], [3]);
  });

  it('fails the read in flight and every read after, once the device has gone', async () => {
    const q = new PacketQueue();
    const reading = q.read(1000);
    q.fail(new Error('The device was unplugged.'));
    await assert.rejects(reading, /unplugged/);
    await assert.rejects(q.read(5), /unplugged/);
    // Anything still queued belonged to a conversation that is over.
    q.push(packet(1));
    await assert.rejects(q.read(5), /unplugged/);
  });

  it('refuses two reads at once', async () => {
    const q = new PacketQueue();
    const first = q.read(20);
    await assert.rejects(q.read(20), /already busy/);
    await assert.rejects(first, (e: Error) => e instanceof TransportTimeout);
  });
});

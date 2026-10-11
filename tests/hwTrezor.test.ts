import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { accountXpub, bip32, bip48Path, deriveAddress, masterFingerprint } from '../src/lib/bitcoin';
import { buildPsbt, finalizeAndExtract, signPsbtWithMnemonic, summarisePsbt } from '../src/lib/wallet';
import { MultisigWallet, NetworkName } from '../src/lib/types';
import { decodeMessage, encodeMessage, Message, MessageSchema } from '../src/lib/hw/protobuf';
import { DevicePrompts, PacketTransport, TransportTimeout, UserCancelled } from '../src/lib/hw/types';
import { encodePackets, MAX_MESSAGE_BYTES, readMessage, writeMessage } from '../src/lib/hw/trezor/codec';
import { checkFeatures, encodeXpub, MIN_FIRMWARE, TrezorDevice, TrezorFailure } from '../src/lib/hw/trezor';
import * as M from '../src/lib/hw/trezor/messages';
import { normalisePassphrase } from '../src/lib/hw/trezor/session';
import { answerRequest, derToCompact, parsePath, planSigning } from '../src/lib/hw/trezor/signTx';
import { DEST_MAINNET, MNEMONICS, makeFundedSnapshot, makeWallet } from './helpers';
import { SimulatedTrezor, Wire } from './hwTrezorSimulator';

const H = 0x80000000;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const SEED = MNEMONICS[0];

/** Packets handed out one by one; when they run out, the read times out at once. */
function packetsTransport(packets: Buffer[]): PacketTransport & { written: Buffer[] } {
  const written: Buffer[] = [];
  return {
    packetSize: 64,
    written,
    write: async (packet) => {
      written.push(Buffer.from(packet));
    },
    read: async () => {
      const next = packets.shift();
      if (!next) throw new TransportTimeout();
      return next;
    },
    close: async () => {},
  };
}

interface Phone {
  prompts: DevicePrompts;
  statuses: string[];
  pinAsked: number;
  passphraseAsked: boolean[];
  pin: string | Error;
  passphrase: string | null | Error;
}

function phone(): Phone {
  const state: Phone = {
    statuses: [],
    pinAsked: 0,
    passphraseAsked: [],
    pin: '1',
    passphrase: '',
    prompts: {
      status: (message) => state.statuses.push(message),
      pinMatrix: async () => {
        state.pinAsked++;
        if (state.pin instanceof Error) throw state.pin;
        return state.pin;
      },
      passphrase: async (canEnterOnDevice) => {
        state.passphraseAsked.push(canEnterOnDevice);
        if (state.passphrase instanceof Error) throw state.passphrase;
        return state.passphrase;
      },
      confirmPairing: async () => true,
    },
  };
  return state;
}

function driverFor(device: PacketTransport, user = phone()): { trezor: TrezorDevice; user: Phone } {
  const trezor = new TrezorDevice(device, {
    prompts: user.prompts,
    memory: { get: async () => null, set: async () => {} },
  });
  return { trezor, user };
}

/** A wallet whose first cosigner is the simulated device's key. */
function walletFor(network: NetworkName = 'mainnet', m = 2): MultisigWallet {
  return makeWallet(m, [SEED, MNEMONICS[1], MNEMONICS[2]], network);
}

function fundedPsbt(
  wallet: MultisigWallet,
  values: number[],
  amount: number,
  sendMax = false,
  withPrevious = true
): bitcoin.Psbt {
  const { snapshot, transactions } = makeFundedSnapshot(wallet, values);
  const to = wallet.network === 'mainnet' ? DEST_MAINNET : 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const { psbt } = buildPsbt(wallet, snapshot, to, amount, 5, sendMax);
  if (!withPrevious) return psbt;
  psbt.txInputs.forEach((input, i) => {
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    psbt.updateInput(i, { nonWitnessUtxo: Buffer.from(transactions.get(txid)!, 'hex') });
  });
  return psbt;
}

// ---------------------------------------------------------------------------

describe('Trezor packet codec', () => {
  it('frames a short message in one packet', () => {
    const packets = encodePackets(M.MessageType.Initialize, Buffer.alloc(0));
    assert.equal(packets.length, 1);
    assert.equal(hex(packets[0]), '3f2323' + '0000' + '00000000' + '00'.repeat(55));

    const ack = encodePackets(M.MessageType.PinMatrixAck, Buffer.from('0a0437313933', 'hex'));
    assert.equal(hex(ack[0]), '3f2323' + '0013' + '00000006' + '0a0437313933' + '00'.repeat(49));
  });

  it('spreads a long message over packets of exactly 64 bytes', () => {
    const body = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
    const packets = encodePackets(22, body);
    // 55 bytes ride with the header, then 63 at a time: 55 + 63 + 63 + 19.
    assert.equal(packets.length, 4);
    for (const p of packets) assert.equal(p.length, 64);
    assert.equal(hex(packets[0].subarray(0, 9)), '3f2323' + '0016' + '000000c8');
    assert.equal(hex(packets[0].subarray(9)), hex(body.subarray(0, 55)));
    assert.equal(packets[1][0], 0x3f);
    assert.equal(hex(packets[1].subarray(1)), hex(body.subarray(55, 118)));
    assert.equal(hex(packets[3].subarray(1, 20)), hex(body.subarray(181)));
    assert.equal(hex(packets[3].subarray(20)), '00'.repeat(44));
  });

  it('fills the first packet exactly without starting another', () => {
    assert.equal(encodePackets(1, Buffer.alloc(55, 1)).length, 1);
    assert.equal(encodePackets(1, Buffer.alloc(56, 1)).length, 2);
  });

  it('reads back what it wrote, whatever the length', async () => {
    for (const length of [0, 1, 54, 55, 56, 118, 119, 1000]) {
      const body = Buffer.from(Array.from({ length }, (_, i) => (i * 7) & 0xff));
      const transport = packetsTransport([]);
      await writeMessage(transport, 0x1234, body);
      const message = await readMessage(packetsTransport(transport.written), 1000);
      assert.equal(message.type, 0x1234);
      assert.equal(hex(message.data), hex(body), `length ${length}`);
    }
  });

  it('steps over the tail of a message nobody finished reading', async () => {
    const stray = Buffer.alloc(64, 0xaa);
    stray[0] = 0x3f;
    const real = encodePackets(17, Buffer.from('beef', 'hex'));
    const message = await readMessage(packetsTransport([stray, stray, ...real]), 1000);
    assert.equal(message.type, 17);
    assert.equal(hex(message.data), 'beef');
  });

  it('gives up on a device that sends nothing but noise', async () => {
    const noise = Array.from({ length: 100 }, () => Buffer.alloc(64, 0x55));
    await assert.rejects(readMessage(packetsTransport(noise), 1000), /cannot make sense of/);
  });

  it('refuses a message that breaks off or is interrupted', async () => {
    const packets = encodePackets(17, Buffer.alloc(200, 1));
    await assert.rejects(readMessage(packetsTransport(packets.slice(0, 2)), 1000), TransportTimeout);

    const broken = encodePackets(17, Buffer.alloc(200, 1));
    broken[1] = Buffer.alloc(64, 0); // no '?' at the front
    await assert.rejects(readMessage(packetsTransport(broken), 1000), /broken message/);
  });

  it('refuses a length no Trezor message has', async () => {
    const packet = Buffer.alloc(64);
    Buffer.from('3f2323' + '0011' + 'ffffffff', 'hex').copy(packet);
    await assert.rejects(readMessage(packetsTransport([packet]), 1000), /far larger/);
    assert.throws(() => encodePackets(1, Buffer.alloc(MAX_MESSAGE_BYTES + 1)), /too large/);
  });

  it('passes a timeout through untouched', async () => {
    await assert.rejects(readMessage(packetsTransport([]), 1000), TransportTimeout);
  });
});

// ---------------------------------------------------------------------------

/**
 * Bytes produced by SatoshiLabs' own python-trezor 0.20.2 for the same
 * messages (generated once, outside this repository). That library also
 * writes fields this driver never sets, so the comparison is made through
 * this driver's view of each message: what it sends must be exactly what the
 * reference sent, less the fields it does not know.
 */
describe('Trezor messages against python-trezor', () => {
  const node1 = {
    depth: 4,
    fingerprint: 0x1cf3a4d6,
    child_num: H + 2,
    chain_code: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    public_key: Buffer.from([2, ...Array.from({ length: 32 }, (_, i) => 32 + i)]),
  };
  const node2 = {
    depth: 4,
    fingerprint: 0xffffffff,
    child_num: H + 2,
    chain_code: Buffer.from(Array.from({ length: 32 }, (_, i) => 64 + i)),
    public_key: Buffer.from([3, ...Array.from({ length: 32 }, (_, i) => 96 + i)]),
  };
  const multisig = {
    nodes: [node1, node2],
    address_n: [1, 7],
    signatures: [Buffer.alloc(0), Buffer.alloc(0)],
    m: 2,
    pubkeys_order: M.MultisigPubkeysOrder.LEXICOGRAPHIC,
  };
  const account = [H + 48, H, H, H + 2];

  /** name, schema, what the driver sends, what the reference wrote, whether byte for byte, and any default the reference spells out. */
  type Row = [string, MessageSchema, Message, string, boolean, ((reference: Message) => void)?];
  const outgoing: Row[] = [
    [
      'GetPublicKey',
      M.GetPublicKey,
      { address_n: account, coin_name: 'Bitcoin', script_type: M.InputScriptType.SPENDADDRESS },
      '08b0808080080880808080080880808080080882808080082207426974636f696e2800',
      true,
    ],
    [
      'GetPublicKey for the master key',
      M.GetPublicKey,
      { address_n: [], coin_name: 'Bitcoin', script_type: M.InputScriptType.SPENDADDRESS },
      '2207426974636f696e2800',
      true,
    ],
    ['PinMatrixAck', M.PinMatrixAck, { pin: '7193' }, '0a0437313933', true],
    [
      'PassphraseAck, typed on the phone',
      M.PassphraseAck,
      { passphrase: 'correct horse', on_device: false },
      '0a0d636f727265637420686f7273651800',
      true,
    ],
    ['PassphraseAck, typed on the device', M.PassphraseAck, { on_device: true }, '1801', true],
    [
      'SignTx',
      M.SignTx,
      { outputs_count: 2, inputs_count: 3, coin_name: 'Testnet', version: 2, lock_time: 800000, serialize: false },
      '080210031a07546573746e657420022880ea30580060006800',
      false,
    ],
    [
      'TxAck with a multisig input',
      M.TxAck,
      {
        tx: {
          inputs: [
            {
              address_n: [...account, 0, 5],
              prev_hash: Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i)),
              prev_index: 1,
              sequence: 0xfffffffd,
              script_type: M.InputScriptType.SPENDWITNESS,
              multisig,
              amount: 2_100_000_000_000_000,
            },
          ],
        },
      },
      '0a9002128d0208b0808080080880808080080880808080080882808080080800080512206465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80818283180128fdffffff0f30033ab6011200120018022253080410d6c9cee7011882808080082220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f322102202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f2253080410ffffffff0f1882808080082220404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f322103606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f2801280730014080809dd085bedd03a00100',
      false,
    ],
    [
      'TxAck with a change output',
      M.TxAck,
      {
        tx: {
          outputs: [
            {
              address_n: [...account, 1, 7],
              amount: 12345,
              script_type: M.OutputScriptType.PAYTOWITNESS,
              multisig,
            },
          ],
        },
      },
      '0add012ada0110b0808080081080808080081080808080081082808080081001100718b96020042ab6011200120018022253080410d6c9cee7011882808080082220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f322102202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f2253080410ffffffff0f1882808080082220404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f322103606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f280128073001',
      true,
    ],
    [
      'TxAck with a payment',
      M.TxAck,
      { tx: { outputs: [{ address: DEST_MAINNET, amount: 80000, script_type: M.OutputScriptType.PAYTOADDRESS }] } },
      '0a342a320a2a6263317177353038643671656a7874646734793572337a6172766172793063357877376b7638663374341880f1042000',
      true,
    ],
    [
      'TxAck describing a previous transaction',
      M.TxAck,
      { tx: { version: 2, lock_time: 0, inputs_cnt: 1, outputs_cnt: 2, extra_data_len: 0 } },
      '0a0a08022000300138024800',
      true,
    ],
    [
      'TxAck with an input of a previous transaction',
      M.TxAck,
      {
        tx: {
          inputs: [
            {
              prev_hash: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
              prev_index: 0,
              script_sig: Buffer.from('160014' + '00'.repeat(20), 'hex'),
              sequence: 0xffffffff,
            },
          ],
        },
      },
      '0a4a12481220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f18002217160014000000000000000000000000000000000000000028ffffffff0f3000a00100',
      false,
      // The reference writes the default script type; an input of a finished transaction has none to speak of.
      (reference) => {
        assert.equal(reference.tx.inputs[0].script_type, M.InputScriptType.SPENDADDRESS);
        delete reference.tx.inputs[0].script_type;
      },
    ],
    [
      'TxAck with an output of a previous transaction',
      M.TxAck,
      {
        tx: {
          bin_outputs: [
            {
              amount: 60000,
              script_pubkey: Buffer.from('0020' + hex(Buffer.from(Array.from({ length: 32 }, (_, i) => i))), 'hex'),
            },
          ],
        },
      },
      '0a2a1a2808e0d40312220020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      true,
    ],
  ];

  for (const [name, schema, message, reference, identical, spelledOut] of outgoing) {
    it(`writes ${name} as the reference does`, () => {
      const ours = hex(encodeMessage(schema, message));
      if (identical) assert.equal(ours, reference);
      // Read through this driver's schema, the reference says the same thing.
      const theirs = decodeMessage(schema, Buffer.from(reference, 'hex'));
      spelledOut?.(theirs);
      assert.equal(hex(encodeMessage(schema, theirs)), ours);
    });
  }

  it('reads Features', () => {
    const features = decodeMessage(
      M.Features,
      Buffer.from(
        '0a097472657a6f722e696f10021808200a3801400052094d79205472657a6f726001800100aa0106536166652035f00101f001119a02200000000000000000000000000000000000000000000000000000000000000000e2020454335431900301',
        'hex'
      )
    );
    assert.equal(features.vendor, 'trezor.io');
    assert.deepEqual([features.major_version, features.minor_version, features.patch_version], [2, 8, 10]);
    assert.equal(features.pin_protection, true);
    assert.equal(features.passphrase_protection, false);
    assert.equal(features.label, 'My Trezor');
    assert.equal(features.initialized, true);
    assert.equal(features.unlocked, false);
    assert.equal(features.model, 'Safe 5');
    assert.equal(features.internal_model, 'T3T1');
    assert.deepEqual(features.capabilities, [1, M.CAPABILITY_PASSPHRASE_ENTRY]);
    assert.equal(features.session_id.length, 32);
  });

  it('reads TxRequest, Failure, ButtonRequest and PublicKey', () => {
    const signed = decodeMessage(M.TxRequest, Buffer.from('0800120208011a0c080012083006020101020101', 'hex'));
    assert.equal(signed.request_type, M.RequestType.TXINPUT);
    assert.equal(signed.details.request_index, 1);
    assert.equal(signed.serialized.signature_index, 0);
    assert.equal(hex(signed.serialized.signature), '3006020101020101');

    const previous = decodeMessage(
      M.TxRequest,
      Buffer.from('080212221220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')
    );
    assert.equal(previous.request_type, M.RequestType.TXMETA);
    assert.equal(previous.details.tx_hash.length, 32);

    const failed = decodeMessage(M.Failure, Buffer.from('0807120b50494e20696e76616c6964', 'hex'));
    assert.deepEqual(failed, { code: M.FailureType.PinInvalid, message: 'PIN invalid' });

    const button = decodeMessage(M.ButtonRequest, Buffer.from('08031002220e636f6e6669726d5f6f7574707574', 'hex'));
    assert.deepEqual(button, { code: M.ButtonRequestType.ConfirmOutput, pages: 2, name: 'confirm_output' });

    const key = decodeMessage(
      M.PublicKey,
      Buffer.from(
        '0a53080410d6c9cee7011882808080082220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f322102202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f12047870756218effdb6f50d',
        'hex'
      )
    );
    assert.equal(key.root_fingerprint, 0xdeadbeef);
    assert.equal(key.node.fingerprint, 0x1cf3a4d6);
    assert.equal(key.node.child_num, H + 2);
    assert.equal(hex(key.node.public_key), hex(node1.public_key));
  });

  it('knows the reply a Safe 7 gives to the old protocol', () => {
    // From trezor-firmware rust/trezor-thp: CODEC_V1_RESPONSE.
    const canned = Buffer.alloc(64);
    Buffer.from('3f2323' + '0003' + '00000002' + '0811', 'hex').copy(canned);
    const reply = decodeMessage(M.Failure, canned.subarray(9, 11));
    assert.equal(canned.readUInt16BE(3), M.MessageType.Failure);
    assert.equal(reply.code, M.FailureType.InvalidProtocol);
  });
});

// ---------------------------------------------------------------------------

describe('Trezor paths and signatures', () => {
  it('reads derivation paths in either notation', () => {
    assert.deepEqual(parsePath("m/48'/0'/0'/2'"), [H + 48, H, H, H + 2]);
    assert.deepEqual(parsePath('m/48h/1h/0h/2h/1/7'), [H + 48, H + 1, H, H + 2, 1, 7]);
    assert.deepEqual(parsePath('m'), []);
    assert.deepEqual(parsePath("48'/0'"), [H + 48, H]);
    for (const bad of ["m/48'/x", 'm/-1', "m/2147483648'", 'm/1.5', "m/0''", 'm/1/2/3/4/5/6/7/8/9/10/11']) {
      assert.throws(() => parsePath(bad), /key path/, bad);
    }
  });

  it('turns DER into r‖s', () => {
    assert.equal(hex(derToCompact(Buffer.from('3006020101020101', 'hex'))), '00'.repeat(31) + '01' + '00'.repeat(31) + '01');
    // A leading zero where the top bit of r or s is set.
    const r = 'ff'.repeat(32);
    const s = '7f' + 'ee'.repeat(31);
    const der = `3045022100${r}0220${s}`;
    assert.equal(hex(derToCompact(Buffer.from(der, 'hex'))), r + s);
  });

  it('round-trips real signatures', () => {
    const key = Buffer.alloc(32, 9);
    for (let i = 0; i < 40; i++) {
      const digest = bitcoin.crypto.sha256(Buffer.from([i]));
      const signature = Buffer.from(ecc.sign(digest, key));
      const der = bitcoin.script.signature.encode(signature, 1);
      assert.equal(hex(derToCompact(der.subarray(0, der.length - 1))), hex(signature));
    }
  });

  it('refuses what is not strict DER', () => {
    for (const bad of ['', '00', '3006020101020101ff', '30060201010201', '3007020200010201 01'.replace(' ', '')]) {
      assert.throws(() => derToCompact(Buffer.from(bad, 'hex')), /cannot read/, bad);
    }
  });

  it('normalises a passphrase the way BIP39 does', () => {
    // U+212B ANGSTROM SIGN decomposes to A + combining ring.
    assert.equal(normalisePassphrase('Å'), 'Å');
    assert.equal(normalisePassphrase('plain'), 'plain');
  });

  it('serialises a public key the way BIP32 says', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const xpub = accountXpub(SEED, network);
      const node = bip32.fromBase58(xpub, network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);
      const rebuilt = encodeXpub(
        {
          depth: node.depth,
          fingerprint: node.parentFingerprint,
          child_num: node.index,
          chain_code: Buffer.from(node.chainCode),
          public_key: Buffer.from(node.publicKey),
        },
        network
      );
      assert.equal(rebuilt, xpub);
    }
    const notOnCurve = { depth: 1, fingerprint: 0, child_num: 0, chain_code: Buffer.alloc(32), public_key: Buffer.alloc(33, 5) };
    assert.throws(() => encodeXpub(notOnCurve, 'mainnet'), /usable public key/);
    assert.throws(() => encodeXpub({ ...notOnCurve, chain_code: Buffer.alloc(31) }, 'mainnet'), /usable public key/);
  });
});

// ---------------------------------------------------------------------------

describe('Trezor connection', () => {
  const healthy: Message = { vendor: 'trezor.io', major_version: 2, minor_version: 8, patch_version: 10, initialized: true };

  it('names the models', () => {
    assert.equal(checkFeatures({ ...healthy, major_version: 1, minor_version: 12, patch_version: 1, model: '1' }).model, 'Trezor Model One');
    assert.equal(checkFeatures({ ...healthy, major_version: 1, minor_version: 9, patch_version: 1 }).model, 'Trezor Model One');
    assert.equal(checkFeatures({ ...healthy, model: 'T' }).model, 'Trezor Model T');
    assert.equal(checkFeatures({ ...healthy, model: 'Safe 3' }).model, 'Trezor Safe 3');
    assert.equal(checkFeatures({ ...healthy, model: 'Safe 5' }).model, 'Trezor Safe 5');
    assert.deepEqual(checkFeatures({ ...healthy, model: 'T', label: 'Savings' }), {
      model: 'Trezor Model T',
      firmware: '2.8.10',
      label: 'Savings',
    });
    assert.equal(checkFeatures({ ...healthy, label: '' }).label, undefined);
  });

  it('turns away what it cannot work with, and says why', () => {
    assert.throws(() => checkFeatures({ ...healthy, bootloader_mode: true, initialized: undefined }), /bootloader mode/);
    assert.throws(() => checkFeatures({ ...healthy, firmware_present: false }), /no firmware/);
    assert.throws(() => checkFeatures({ ...healthy, initialized: false }), /not been set up/);
    assert.throws(() => checkFeatures({ ...healthy, vendor: 'keepkey.com' }), /not Trezor/);
    assert.throws(() => checkFeatures({ ...healthy, vendor: undefined }), /not Trezor/);
    assert.throws(() => checkFeatures({ ...healthy, major_version: 3 }), /does not know/);
  });

  it('insists on firmware that checks input amounts', () => {
    const [a1, b1, c1] = MIN_FIRMWARE[1];
    const [a2, b2, c2] = MIN_FIRMWARE[2];
    const at = (major: number, minor: number, patch: number) =>
      checkFeatures({ ...healthy, major_version: major, minor_version: minor, patch_version: patch });
    assert.equal(at(a1, b1, c1).firmware, `${a1}.${b1}.${c1}`);
    assert.equal(at(a2, b2, c2).firmware, `${a2}.${b2}.${c2}`);
    assert.throws(() => at(a1, b1, c1 - 1), /update it in Trezor Suite/);
    assert.throws(() => at(a2, b2, c2 - 1), /update it in Trezor Suite/);
    assert.throws(() => at(1, 8, 3), /1\.8\.3/);
    assert.throws(() => at(2, 1, 8), /update it/);
    // A later minor with an earlier patch number is still later.
    assert.equal(at(2, 4, 0).firmware, '2.4.0');
    assert.equal(at(1, 10, 0).firmware, '1.10.0');
  });

  it('introduces itself and learns the master fingerprint', async () => {
    const device = new SimulatedTrezor(SEED);
    const { trezor, user } = driverFor(device);
    assert.deepEqual(await trezor.connect(), { model: 'Trezor Model T', firmware: '2.8.10', label: 'Simulated' });
    assert.equal(await trezor.masterFingerprint(), masterFingerprint(SEED));
    assert.deepEqual(device.typesReceived(), [M.MessageType.Initialize, M.MessageType.GetPublicKey]);
    assert.deepEqual(user.statuses, []);
  });

  it('will not be used before it is connected', async () => {
    const { trezor } = driverFor(new SimulatedTrezor(SEED));
    await assert.rejects(trezor.masterFingerprint(), /Connect to the Trezor first/);
    await assert.rejects(trezor.getKey('mainnet'), /Connect to the Trezor first/);
  });

  it('recognises a Safe 7 and says it cannot be used yet', async () => {
    const device = new SimulatedTrezor(SEED);
    device.override = () => [{ type: M.MessageType.Failure, message: { code: M.FailureType.InvalidProtocol } }];
    const { trezor } = driverFor(device);
    await assert.rejects(trezor.connect(), /Safe 7.*cannot use over USB yet/);
    // One question was enough: it did not go on to ask for keys.
    assert.deepEqual(device.typesReceived(), [M.MessageType.Initialize]);
  });

  it('hears out a device that was interrupted before it introduces itself', async () => {
    const device = new SimulatedTrezor(SEED);
    device.override = (incoming) => {
      if (incoming.type !== M.MessageType.Initialize) return null;
      device.override = null;
      return [
        { type: M.MessageType.Failure, message: { code: M.FailureType.ActionCancelled, message: 'Cancelled' } },
        ...((device as any).respond(incoming) as Wire[]),
      ];
    };
    const { trezor } = driverFor(device);
    assert.equal((await trezor.connect()).model, 'Trezor Model T');
    assert.equal(await trezor.masterFingerprint(), masterFingerprint(SEED));
  });

  it('reports what a device said if it never introduces itself', async () => {
    const device = new SimulatedTrezor(SEED);
    device.override = () => [{ type: M.MessageType.Failure, message: { code: M.FailureType.Busy, message: 'Device is busy' } }];
    await assert.rejects(driverFor(device).trezor.connect(), /would not start a session: Device is busy/);
  });

  it('says so when nothing answers', async () => {
    const device = new SimulatedTrezor(SEED);
    device.override = () => [];
    await assert.rejects(driverFor(device).trezor.connect(), /not answering/);
  });

  it('says so when what answers is not a Trezor', async () => {
    const device = new SimulatedTrezor(SEED);
    device.override = () => [{ type: M.MessageType.Success, message: { message: 'hello' } }];
    await assert.rejects(driverFor(device).trezor.connect(), /did not introduce itself/);
  });

  it('clears out what an earlier host left unread', async () => {
    const device = new SimulatedTrezor(SEED);
    // A whole stale reply, and the tail of another.
    const tail = Buffer.alloc(64, 0x11);
    tail[0] = 0x3f;
    device.leaveBehind(...encodePackets(M.MessageType.Failure, encodeMessage(M.Failure, { code: 4 })), tail);
    const { trezor } = driverFor(device);
    await trezor.connect();
    assert.equal(await trezor.masterFingerprint(), masterFingerprint(SEED));
  });

  it('refuses a device that contradicts itself about its key', async () => {
    const device = new SimulatedTrezor(SEED);
    const real = device;
    device.override = (incoming) => {
      if (incoming.type !== M.MessageType.GetPublicKey) return null;
      real.override = null;
      const honest = (real as any).respond(incoming) as Wire[];
      honest[0].message.root_fingerprint = 0x01020304;
      return honest;
    };
    await assert.rejects(driverFor(device).trezor.connect(), /two different answers/);
  });

  it('ends the session when it closes', async () => {
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    await trezor.close();
    assert.equal(device.typesReceived().at(-1), M.MessageType.EndSession);
    assert.ok(device.closed);
    await assert.rejects(trezor.getKey('mainnet'), /closed/);
    await trezor.close(); // closing twice is harmless
  });
});

// ---------------------------------------------------------------------------

describe('Trezor PIN, passphrase and buttons', () => {
  function modelOne(pin: string | null): SimulatedTrezor {
    const device = new SimulatedTrezor(SEED);
    device.features = {
      ...device.features,
      major_version: 1,
      minor_version: 12,
      patch_version: 1,
      model: '1',
      internal_model: undefined,
      capabilities: [1],
      pin_protection: pin !== null,
      unlocked: pin === null,
    };
    device.pin = pin;
    return device;
  }

  it('sends the PIN as positions on the keypad', async () => {
    const device = modelOne('1234');
    // The device shows 847 / 315 / 926 reading its digits left to right from
    // position 1: so 1 is at position 5, 2 at 8, 3 at 4, 4 at 2.
    const user = phone();
    user.pin = '5842';
    const { trezor } = driverFor(device, user);
    await trezor.connect();
    assert.equal(user.pinAsked, 1);
    const ack = device.received.find((w) => w.type === M.MessageType.PinMatrixAck)!;
    assert.equal(ack.message.pin, '5842');
    assert.deepEqual(user.statuses, ['Unlock your Trezor.']);
    // Unlocked now: reading a key asks for nothing more.
    await trezor.getKey('mainnet');
    assert.equal(user.pinAsked, 1);
  });

  it('explains a wrong PIN', async () => {
    const device = modelOne('1234');
    const user = phone();
    user.pin = '1111';
    const { trezor } = driverFor(device, user);
    await assert.rejects(trezor.connect(), (e: any) => {
      assert.ok(e instanceof TrezorFailure);
      assert.equal(e.code, M.FailureType.PinInvalid);
      assert.match(e.message, /Wrong PIN/);
      return true;
    });
  });

  it('calls the device off when the PIN prompt is cancelled', async () => {
    const device = modelOne('1234');
    const user = phone();
    user.pin = new UserCancelled();
    const { trezor } = driverFor(device, user);
    await assert.rejects(trezor.connect(), UserCancelled);
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
    // The cancellation's reply was read, so the next attempt starts clean.
    user.pin = '5842';
    const again = driverFor(device, user).trezor;
    await again.connect();
    assert.equal(await again.masterFingerprint(), masterFingerprint(SEED));
  });

  it('never sends a PIN that is not keypad positions', async () => {
    for (const bad of ['', '1204', '12a4', '1'.repeat(51)]) {
      const device = modelOne('1234');
      const user = phone();
      user.pin = bad;
      await assert.rejects(driverFor(device, user).trezor.connect(), /keypad positions/);
      assert.ok(!device.typesReceived().includes(M.MessageType.PinMatrixAck));
      assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
    }
  });

  it('opens the wallet behind a passphrase typed on the phone', async () => {
    const device = modelOne(null);
    device.features = { ...device.features, passphrase_protection: true };
    const user = phone();
    user.passphrase = 'correct horse';
    const { trezor } = driverFor(device, user);
    await trezor.connect();
    // A Model One has no keyboard to offer.
    assert.deepEqual(user.passphraseAsked, [false]);
    const hidden = bip32.fromSeed(bip39.mnemonicToSeedSync(SEED, 'correct horse'));
    assert.equal(await trezor.masterFingerprint(), hex(hidden.fingerprint));
    const key = await trezor.getKey('mainnet');
    assert.equal(key.xpub, hidden.derivePath(bip48Path('mainnet')).neutered().toBase58());
    assert.deepEqual(user.passphraseAsked, [false], 'asked once per connection');
    const ack = device.received.find((w) => w.type === M.MessageType.PassphraseAck)!;
    assert.deepEqual(ack.message, { passphrase: 'correct horse', on_device: false });
  });

  it('lets the passphrase be typed on a device that has a keyboard', async () => {
    const device = new SimulatedTrezor(SEED);
    device.features = { ...device.features, passphrase_protection: true };
    const user = phone();
    user.passphrase = null;
    const { trezor } = driverFor(device, user);
    await trezor.connect();
    assert.deepEqual(user.passphraseAsked, [true]);
    const ack = device.received.find((w) => w.type === M.MessageType.PassphraseAck)!;
    assert.deepEqual(ack.message, { on_device: true });
    assert.deepEqual(user.statuses, ['Enter your passphrase on the Trezor.', 'Enter your passphrase on the Trezor.']);
    const hidden = bip32.fromSeed(bip39.mnemonicToSeedSync(SEED, 'typed on device'));
    assert.equal(await trezor.masterFingerprint(), hex(hidden.fingerprint));
  });

  it('will not pretend a Model One has a keyboard', async () => {
    const device = modelOne(null);
    device.features = { ...device.features, passphrase_protection: true };
    const user = phone();
    user.passphrase = null;
    await assert.rejects(driverFor(device, user).trezor.connect(), /no keyboard of its own/);
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
  });

  it('refuses a passphrase longer than the device can take', async () => {
    const device = new SimulatedTrezor(SEED);
    device.features = { ...device.features, passphrase_protection: true };
    const user = phone();
    // 17 characters, 51 bytes: the limit is on bytes.
    user.passphrase = '€'.repeat(17);
    await assert.rejects(driverFor(device, user).trezor.connect(), /too long/);
    assert.ok(!device.typesReceived().includes(M.MessageType.PassphraseAck));

    user.passphrase = 'x'.repeat(50);
    await driverFor(new SimulatedTrezor(SEED), user).trezor.connect();
  });

  it('calls the device off when the passphrase prompt is cancelled', async () => {
    const device = new SimulatedTrezor(SEED);
    device.features = { ...device.features, passphrase_protection: true };
    const user = phone();
    user.passphrase = new UserCancelled();
    await assert.rejects(driverFor(device, user).trezor.connect(), UserCancelled);
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
  });

  it('answers the passphrase handshake of firmware from before 2020', async () => {
    const device = new SimulatedTrezor(SEED);
    let stage = 0;
    device.override = (incoming) => {
      if (incoming.type === M.MessageType.GetPublicKey && stage === 0) {
        stage = 1;
        return [{ type: M.MessageType.PassphraseRequest, message: { _on_device: true } }];
      }
      if (incoming.type === M.MessageType.PassphraseAck && stage === 1) {
        stage = 2;
        assert.deepEqual(incoming.message, {});
        return [{ type: M.MessageType.Deprecated_PassphraseStateRequest, message: {} }];
      }
      if (incoming.type === M.MessageType.Deprecated_PassphraseStateAck && stage === 2) {
        stage = 3;
        device.override = null;
        return (device as any).respond({ type: M.MessageType.GetPublicKey, message: { address_n: [], coin_name: 'Bitcoin' } });
      }
      return null;
    };
    const { trezor, user } = driverFor(device);
    await trezor.connect();
    assert.equal(stage, 3);
    assert.deepEqual(user.passphraseAsked, [], 'the device asked for it itself');
  });

  it('maps what the device refuses to words a person can act on', async () => {
    const cases: [number, string, RegExp, boolean][] = [
      [M.FailureType.ActionCancelled, 'Cancelled', /Cancelled on the Trezor/, true],
      [M.FailureType.PinCancelled, 'PIN cancelled', /PIN entry was cancelled/, true],
      [M.FailureType.NotInitialized, 'Device not initialized', /not been set up/, false],
      [M.FailureType.Busy, 'Device is busy', /busy with something else/, false],
      [M.FailureType.NotEnoughFunds, 'Not enough funds', /spends more than its coins hold/, false],
      [M.FailureType.DataError, 'Forbidden key path', /safety checks/, false],
      [M.FailureType.DataError, 'Invalid multisig parameters', /refused: Invalid multisig parameters/, false],
      [M.FailureType.FirmwareError, 'oops', /internal error.*oops/, false],
      [M.FailureType.ProcessError, '', /refused the request \(code 9\)/, false],
    ];
    for (const [code, message, expected, cancelled] of cases) {
      const device = new SimulatedTrezor(SEED);
      const { trezor } = driverFor(device);
      await trezor.connect();
      device.override = (incoming) =>
        incoming.type === M.MessageType.GetPublicKey ? [{ type: M.MessageType.Failure, message: { code, message } }] : null;
      await assert.rejects(trezor.getKey('mainnet'), (e: any) => {
        assert.match(e.message, expected);
        assert.equal(e instanceof UserCancelled, cancelled, message);
        return true;
      });
    }
  });

  it('is not thrown by an answer of the wrong kind', async () => {
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    device.override = (incoming) =>
      incoming.type === M.MessageType.GetPublicKey ? [{ type: M.MessageType.Success, message: { message: 'ok' } }] : null;
    await assert.rejects(trezor.getKey('mainnet'), /answered with Success where PublicKey was expected/);
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
    // And it recovers.
    device.override = null;
    assert.equal((await trezor.getKey('mainnet')).xpub, accountXpub(SEED, 'mainnet'));
  });

  it('stops following a device that asks for buttons for ever', async () => {
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    device.override = (incoming) =>
      incoming.type === M.MessageType.GetPublicKey || incoming.type === M.MessageType.ButtonAck
        ? [{ type: M.MessageType.ButtonRequest, message: { code: 1 } }]
        : null;
    await assert.rejects(trezor.getKey('mainnet'), /kept asking for confirmation/);
  });
});

// ---------------------------------------------------------------------------

describe('Trezor key export', () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    it(`reads the BIP48 account key (${network})`, async () => {
      const device = new SimulatedTrezor(SEED);
      const { trezor, user } = driverFor(device);
      await trezor.connect();
      assert.deepEqual(await trezor.getKey(network), {
        xpub: accountXpub(SEED, network),
        fingerprint: masterFingerprint(SEED),
        path: bip48Path(network),
        network,
      });
      const request = device.received.at(-1)!;
      assert.deepEqual(request.message, {
        address_n: [H + 48, network === 'mainnet' ? H : H + 1, H, H + 2],
        coin_name: network === 'mainnet' ? 'Bitcoin' : 'Testnet',
        script_type: M.InputScriptType.SPENDADDRESS,
      });
      assert.deepEqual(user.statuses, [], 'nothing to confirm on the device');
    });
  }

  it('reads a key at any path, and reports the path in one notation', async () => {
    const { trezor } = driverFor(new SimulatedTrezor(SEED));
    await trezor.connect();
    const key = await trezor.getKey('mainnet', 'm/45h/0');
    assert.equal(key.path, "m/45'/0");
    const expected = bip32.fromSeed(bip39.mnemonicToSeedSync(SEED)).derivePath("m/45'/0").neutered().toBase58();
    assert.equal(key.xpub, expected);
    await assert.rejects(trezor.getKey('mainnet', 'm'), /needs a derivation path/);
    await assert.rejects(trezor.getKey('mainnet', 'm/nonsense'), /key path/);
  });

  const tamper = (change: (reply: Message) => void) => {
    const device = new SimulatedTrezor(SEED);
    let armed = false;
    device.override = (incoming) => {
      if (!armed || incoming.type !== M.MessageType.GetPublicKey) return null;
      device.override = null;
      const honest = (device as any).respond(incoming) as Wire[];
      change(honest[0].message);
      return honest;
    };
    return { device, arm: () => (armed = true) };
  };

  it('refuses a key that is not the one at the path asked for', async () => {
    for (const change of [
      (reply: Message) => (reply.node.depth = 3),
      (reply: Message) => (reply.node.child_num = H + 1),
    ]) {
      const { device, arm } = tamper(change);
      const { trezor } = driverFor(device);
      await trezor.connect();
      arm();
      await assert.rejects(trezor.getKey('mainnet'), /different path/);
    }
  });

  it('refuses a key whose two descriptions disagree', async () => {
    const other = accountXpub(MNEMONICS[1], 'mainnet');
    const { device, arm } = tamper((reply) => (reply.xpub = other));
    const { trezor } = driverFor(device);
    await trezor.connect();
    arm();
    await assert.rejects(trezor.getKey('mainnet'), /does not match its own description/);
  });

  it('refuses a key for the other network', async () => {
    const { device, arm } = tamper((reply) => (reply.xpub = accountXpub(SEED, 'testnet')));
    const { trezor } = driverFor(device);
    await trezor.connect();
    arm();
    await assert.rejects(trezor.getKey('mainnet'), /not for mainnet/);
  });

  it('refuses a key that is not a key', async () => {
    const { device, arm } = tamper((reply) => (reply.node.public_key = Buffer.alloc(33, 5)));
    const { trezor } = driverFor(device);
    await trezor.connect();
    arm();
    await assert.rejects(trezor.getKey('mainnet'), /usable public key/);
  });
});

// ---------------------------------------------------------------------------

describe('Trezor signing plan', () => {
  const wallet = walletFor('mainnet');
  const fingerprint = wallet.cosigners[0].fingerprint;

  it('describes each input from the wallet’s own keys', () => {
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const plan = planSigning({ wallet, psbt, fingerprint });
    assert.equal(plan.coinName, 'Bitcoin');
    assert.equal(plan.version, 2);
    assert.equal(plan.lockTime, 0);
    assert.equal(plan.inputs.length, 2);

    plan.inputs.forEach((input, i) => {
      const spent = psbt.txInputs[i];
      const derived = deriveAddress(wallet, 0, i);
      assert.deepEqual(input.address_n, [H + 48, H, H, H + 2, 0, i]);
      // Named as people read transaction ids, not as transactions store them.
      assert.equal(hex(input.prev_hash), hex(Buffer.from(spent.hash).reverse()));
      assert.equal(input.prev_index, 1);
      assert.equal(input.sequence, 0xfffffffd);
      assert.equal(input.script_type, M.InputScriptType.SPENDWITNESS);
      assert.equal(input.amount, psbt.data.inputs[i].witnessUtxo!.value);
      assert.equal(input.multisig.m, 2);
      assert.deepEqual(input.multisig.address_n, [0, i]);
      assert.equal(input.multisig.signatures.length, 3);
      assert.equal(input.multisig.pubkeys_order, M.MultisigPubkeysOrder.LEXICOGRAPHIC);

      // Given in the order the script has them, for firmware that takes the order as given.
      const keys = (input.multisig.nodes as Message[]).map((node) =>
        Buffer.from(bip32.fromPublicKey(node.public_key, node.chain_code).derive(0).derive(i).publicKey)
      );
      const script = bitcoin.payments.p2ms({ m: 2, pubkeys: keys }).output!;
      assert.equal(hex(script), hex(derived.witnessScript));
      assert.equal(hex(plan.expected[i].pubkey), hex(derived.derivations[0].pubkey));
    });
  });

  it('gives the account keys whole, not just their public keys', () => {
    const plan = planSigning({ wallet, psbt: fundedPsbt(wallet, [60_000], 30_000), fingerprint });
    const nodes = plan.inputs[0].multisig.nodes as Message[];
    const rebuilt = nodes.map((node) => encodeXpub(node, 'mainnet')).sort();
    assert.deepEqual(rebuilt, wallet.cosigners.map((c) => c.xpub).sort());
  });

  it('marks as change only what the wallet derives on its change branch', () => {
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const plan = planSigning({ wallet, psbt, fingerprint });
    assert.equal(plan.outputs.length, 2);
    assert.deepEqual(plan.outputs[0], {
      address: DEST_MAINNET,
      amount: 80_000,
      script_type: M.OutputScriptType.PAYTOADDRESS,
    });
    const change = plan.outputs[1];
    assert.deepEqual(change.address_n, [H + 48, H, H, H + 2, 1, 0]);
    assert.equal(change.script_type, M.OutputScriptType.PAYTOWITNESS);
    assert.equal(change.address, undefined);
    assert.deepEqual(change.multisig.address_n, [1, 0]);
    assert.equal(change.amount, psbt.txOutputs[1].value);
  });

  it('does not take a PSBT’s word that an output is change', () => {
    // An attacker's address dressed up with this wallet's change derivation.
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const honest = psbt.data.outputs[1];
    const theft = new bitcoin.Psbt();
    theft.setVersion(2);
    psbt.txInputs.forEach((input, i) => {
      theft.addInput({ hash: input.hash, index: input.index, sequence: input.sequence, ...psbt.data.inputs[i] });
    });
    theft.addOutput({ address: DEST_MAINNET, value: 80_000 });
    const attacker = makeWallet(2, [MNEMONICS[3], MNEMONICS[4], MNEMONICS[1]], 'mainnet');
    theft.addOutput({
      script: deriveAddress(attacker, 1, 0).script,
      value: psbt.txOutputs[1].value,
      bip32Derivation: honest.bip32Derivation,
      witnessScript: honest.witnessScript,
    });

    const plan = planSigning({ wallet, psbt: theft, fingerprint });
    // Sent as a payment to an address, so the device shows it to its owner.
    assert.deepEqual(plan.outputs[1], {
      address: deriveAddress(attacker, 1, 0).address,
      amount: psbt.txOutputs[1].value,
      script_type: M.OutputScriptType.PAYTOADDRESS,
    });
  });

  it('shows a payment to one of the wallet’s own receive addresses', () => {
    const own = deriveAddress(wallet, 0, 9);
    const { snapshot, transactions } = makeFundedSnapshot(wallet, [60_000]);
    const { psbt } = buildPsbt(wallet, snapshot, own.address, 30_000, 5, false);
    psbt.updateInput(0, {
      nonWitnessUtxo: Buffer.from(transactions.get(Buffer.from(psbt.txInputs[0].hash).reverse().toString('hex'))!, 'hex'),
    });
    psbt.updateOutput(0, { bip32Derivation: own.derivations, witnessScript: own.witnessScript });
    const plan = planSigning({ wallet, psbt, fingerprint });
    assert.equal(plan.outputs[0].address, own.address);
    assert.equal(plan.outputs[0].script_type, M.OutputScriptType.PAYTOADDRESS);
  });

  it('carries the transactions being spent from, without their witnesses', () => {
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const plan = planSigning({ wallet, psbt, fingerprint });
    assert.equal(plan.prevTxs.size, 2);
    psbt.txInputs.forEach((input, i) => {
      const txid = Buffer.from(input.hash).reverse().toString('hex');
      const funding = bitcoin.Transaction.fromBuffer(Buffer.from(psbt.data.inputs[i].nonWitnessUtxo!));
      const prev = plan.prevTxs.get(txid)!;
      assert.equal(prev.version, funding.version);
      assert.equal(prev.inputs.length, funding.ins.length);
      assert.equal(prev.outputs.length, funding.outs.length);
      assert.equal(prev.outputs[1].amount, psbt.data.inputs[i].witnessUtxo!.value);
      assert.equal(hex(prev.inputs[0].prev_hash), hex(Buffer.from(funding.ins[0].hash).reverse()));
    });
  });

  const refused: [string, (psbt: bitcoin.Psbt) => void, RegExp][] = [
    [
      'carries a previous transaction that is another one',
      (psbt) => (psbt.data.inputs[0].nonWitnessUtxo = psbt.data.inputs[1].nonWitnessUtxo),
      /not the one it spends/,
    ],
    [
      'carries a previous transaction that cannot be read',
      (psbt) => (psbt.data.inputs[0].nonWitnessUtxo = Buffer.from('00', 'hex')),
      /cannot be read/,
    ],
    [
      'claims more than the coin is worth',
      (psbt) => (psbt.data.inputs[0].witnessUtxo = { ...psbt.data.inputs[0].witnessUtxo!, value: 61_000 }),
      /does not match the transaction it spends from/,
    ],
    [
      'spends a coin that is not the wallet’s',
      (psbt) => {
        const foreign = deriveAddress(makeWallet(2, [MNEMONICS[3], MNEMONICS[4]], 'mainnet'), 0, 0);
        psbt.data.inputs[0].witnessUtxo = { script: foreign.script, value: 60_000 };
      },
      /does not belong to this wallet/,
    ],
    [
      'carries a witness script that is not the wallet’s',
      (psbt) => (psbt.data.inputs[0].witnessScript = deriveAddress(wallet, 0, 5).witnessScript),
      /does not belong to this wallet/,
    ],
    ['does not say where the key sits', (psbt) => delete psbt.data.inputs[0].bip32Derivation, /does not say where/],
    [
      'claims a position no wallet uses',
      (psbt) => {
        psbt.data.inputs[0].bip32Derivation = psbt.data.inputs[0].bip32Derivation!.map((d) => ({
          ...d,
          path: "m/48'/0'/0'/2'/2/0",
        }));
      },
      /does not say where/,
    ],
    ['has no coin details', (psbt) => delete psbt.data.inputs[0].witnessUtxo, /missing the details/],
    ['asks for an unusual signature', (psbt) => (psbt.data.inputs[0].sighashType = 0x83), /unusual signature type/],
  ];
  for (const [what, damage, expected] of refused) {
    it(`refuses an input that ${what}`, () => {
      const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
      damage(psbt);
      assert.throws(() => planSigning({ wallet, psbt, fingerprint }), expected);
    });
  }

  it('carries a previous transaction whose version has its top bit set', () => {
    const derived = deriveAddress(wallet, 0, 0);
    const funding = new bitcoin.Transaction();
    funding.version = -2147483647; // 0x80000001 as bitcoinjs reads it
    funding.addInput(Buffer.alloc(32, 1), 0);
    funding.addOutput(derived.script, 60_000);
    const snapshot = {
      confirmedSats: 60_000,
      unconfirmedSats: 0,
      utxos: [{ txid: funding.getId(), vout: 0, value: 60_000, address: derived.address, branch: 0, index: 0, confirmed: true }],
      usedAddresses: [],
      nextReceiveIndex: 1,
      nextChangeIndex: 0,
      scannedAt: 0,
    };
    const { psbt } = buildPsbt(wallet, snapshot, DEST_MAINNET, 30_000, 5, false);
    psbt.updateInput(0, { nonWitnessUtxo: funding.toBuffer() });
    const plan = planSigning({ wallet, psbt, fingerprint });
    const meta = answerRequest(plan, {
      request_type: M.RequestType.TXMETA,
      details: { tx_hash: Buffer.from(funding.getId(), 'hex') },
    });
    assert.equal(meta.version, 0x80000001);
    assert.doesNotThrow(() => encodeMessage(M.TxAck, { tx: meta }));
  });

  it('refuses an input that has no previous transaction', () => {
    // As the app stores a transaction: the amounts are claims until the
    // transactions they come from are attached.
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000, false, false);
    assert.throws(() => planSigning({ wallet, psbt, fingerprint }), /missing the transaction it spends from/);
  });

  it('refuses to plan for a key that is not in the wallet', () => {
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    assert.throws(() => planSigning({ wallet, psbt, fingerprint: 'deadbeef' }), /not part of this wallet/);
  });

  it('refuses outputs a Trezor cannot show', () => {
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const raw = new bitcoin.Psbt();
    raw.setVersion(2);
    raw.addInput({ hash: psbt.txInputs[0].hash, index: 1, sequence: 0xfffffffd, ...psbt.data.inputs[0] });
    raw.addOutput({ script: Buffer.from('51', 'hex'), value: 1000 });
    assert.throws(() => planSigning({ wallet, psbt: raw, fingerprint }), /does not pay to an address/);
  });

  it('passes an OP_RETURN output on as data', () => {
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const raw = new bitcoin.Psbt();
    raw.setVersion(2);
    raw.addInput({ hash: psbt.txInputs[0].hash, index: 1, sequence: 0xfffffffd, ...psbt.data.inputs[0] });
    raw.addOutput({ address: DEST_MAINNET, value: 30_000 });
    raw.addOutput({ script: bitcoin.payments.embed({ data: [Buffer.from('hello')] }).output!, value: 0 });
    const plan = planSigning({ wallet, psbt: raw, fingerprint });
    assert.deepEqual(plan.outputs[1], {
      amount: 0,
      script_type: M.OutputScriptType.PAYTOOPRETURN,
      op_return_data: Buffer.from('hello'),
    });
  });

  it('hands the device exactly the piece it asks for', () => {
    const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
    const plan = planSigning({ wallet, psbt, fingerprint });
    const hash = Buffer.from(psbt.txInputs[1].hash).reverse();
    const T = M.RequestType;

    assert.deepEqual(answerRequest(plan, { request_type: T.TXINPUT, details: { request_index: 1 } }), {
      inputs: [plan.inputs[1]],
    });
    assert.deepEqual(answerRequest(plan, { request_type: T.TXOUTPUT, details: { request_index: 0 } }), {
      outputs: [plan.outputs[0]],
    });
    assert.deepEqual(answerRequest(plan, { request_type: T.TXMETA, details: { tx_hash: hash } }), {
      version: 2,
      lock_time: 0,
      inputs_cnt: 1,
      outputs_cnt: 2,
      extra_data_len: 0,
    });
    const prev = plan.prevTxs.get(hex(hash))!;
    assert.deepEqual(answerRequest(plan, { request_type: T.TXINPUT, details: { request_index: 0, tx_hash: hash } }), {
      inputs: [prev.inputs[0]],
    });
    assert.deepEqual(answerRequest(plan, { request_type: T.TXOUTPUT, details: { request_index: 1, tx_hash: hash } }), {
      bin_outputs: [prev.outputs[1]],
    });
    // An empty hash means this transaction, as some firmware writes it.
    assert.deepEqual(
      answerRequest(plan, { request_type: T.TXINPUT, details: { request_index: 0, tx_hash: Buffer.alloc(0) } }),
      { inputs: [plan.inputs[0]] }
    );

    assert.throws(() => answerRequest(plan, { request_type: T.TXINPUT, details: { request_index: 2 } }), /does not have/);
    assert.throws(() => answerRequest(plan, { request_type: T.TXOUTPUT, details: {} }), /does not have/);
    assert.throws(
      () => answerRequest(plan, { request_type: T.TXMETA, details: { tx_hash: Buffer.alloc(32, 1) } }),
      /does not spend from/
    );
    assert.throws(
      () => answerRequest(plan, { request_type: T.TXOUTPUT, details: { request_index: 5, tx_hash: hash } }),
      /does not have/
    );
    assert.throws(() => answerRequest(plan, { request_type: T.TXEXTRADATA, details: { tx_hash: hash } }), /does not have/);
    assert.throws(() => answerRequest(plan, { request_type: 5, details: { request_index: 0 } }), /does not have/);
    assert.throws(() => answerRequest(plan, { request_type: T.TXMETA, details: {} }), /does not have/);
  });
});

// ---------------------------------------------------------------------------

describe('Trezor signing', () => {
  /** Adds the device's signatures and another cosigner's, and proves the result spends. */
  function finish(psbt: bitcoin.Psbt, wallet: MultisigWallet, signatures: { index: number; pubkey: Buffer; signature: Buffer }[]) {
    for (const s of signatures) {
      psbt.updateInput(s.index, {
        partialSig: [{ pubkey: s.pubkey, signature: bitcoin.script.signature.encode(s.signature, 1) }],
      });
    }
    signPsbtWithMnemonic(psbt, MNEMONICS[1], wallet);
    assert.ok(summarisePsbt(psbt, wallet).complete);
    assert.ok(psbt.validateSignaturesOfAllInputs((pubkey, hash, signature) => ecc.verify(hash, pubkey, signature)));
    return bitcoin.Transaction.fromHex(finalizeAndExtract(psbt));
  }

  for (const network of ['mainnet', 'testnet'] as const) {
    for (const sortsKeys of [true, false]) {
      const firmware = sortsKeys ? 'firmware that sorts the keys' : 'firmware that takes them as given';
      it(`signs 2-of-3 with two inputs and change (${network}, ${firmware})`, async () => {
        const wallet = walletFor(network);
        const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
        const device = new SimulatedTrezor(SEED);
        device.sortsKeys = sortsKeys;
        const { trezor, user } = driverFor(device);
        await trezor.connect();
        const signatures = await trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });

        assert.deepEqual(signatures.map((s) => s.index), [0, 1]);
        for (const s of signatures) assert.equal(s.signature.length, 64);
        const tx = finish(psbt, wallet, signatures);
        assert.equal(tx.ins.length, 2);
        assert.equal(tx.outs.length, 2);

        const signTx = device.received.find((w) => w.type === M.MessageType.SignTx)!;
        assert.deepEqual(signTx.message, {
          outputs_count: 2,
          inputs_count: 2,
          coin_name: network === 'mainnet' ? 'Bitcoin' : 'Testnet',
          version: 2,
          lock_time: 0,
          serialize: false,
        });
        // One payment shown, then the total: the change was recognised.
        const buttons = device.sent.filter((w) => w.type === M.MessageType.ButtonRequest).map((w) => w.message.code);
        assert.deepEqual(buttons, [M.ButtonRequestType.ConfirmOutput, M.ButtonRequestType.SignTx]);
        assert.deepEqual(user.statuses, [
          'Sending the transaction to the Trezor.',
          'Check the address and amount on the Trezor, then confirm there.',
          'Check the total and the fee on the Trezor, then confirm there.',
        ]);
      });
    }
  }

  it('signs 3-of-5 from the middle of the key list, five inputs, no change', async () => {
    const wallet = makeWallet(3, [MNEMONICS[1], MNEMONICS[2], SEED, MNEMONICS[3], MNEMONICS[4]], 'mainnet');
    const psbt = fundedPsbt(wallet, [20_000, 21_000, 22_000, 23_000, 24_000], 0, true);
    assert.equal(psbt.txOutputs.length, 1);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    const signatures = await trezor.signMultisig({ wallet, psbt, fingerprint: masterFingerprint(SEED) });
    assert.equal(signatures.length, 5);
    for (const s of signatures) {
      psbt.updateInput(s.index, {
        partialSig: [{ pubkey: s.pubkey, signature: bitcoin.script.signature.encode(s.signature, 1) }],
      });
    }
    signPsbtWithMnemonic(psbt, MNEMONICS[1], wallet);
    signPsbtWithMnemonic(psbt, MNEMONICS[4], wallet);
    finalizeAndExtract(psbt);
  });

  it('signs again what it has already signed, giving the same signatures', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const { trezor } = driverFor(new SimulatedTrezor(SEED));
    await trezor.connect();
    const first = await trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    psbt.updateInput(0, {
      partialSig: [{ pubkey: first[0].pubkey, signature: bitcoin.script.signature.encode(first[0].signature, 1) }],
    });
    const second = await trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    assert.equal(hex(second[0].signature), hex(first[0].signature));
  });

  it('never reaches the device with a transaction the wallet cannot account for', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    psbt.data.inputs[0].witnessUtxo = { ...psbt.data.inputs[0].witnessUtxo!, value: 99_000 };
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    const before = device.received.length;
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /does not match the transaction it spends from/
    );
    assert.equal(device.received.length, before);
  });

  it('refuses to sign as a key the device does not hold', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(MNEMONICS[3]);
    const { trezor } = driverFor(device);
    await trezor.connect();
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /different key.*holds [0-9a-f]{8}/
    );
    assert.ok(!device.typesReceived().includes(M.MessageType.SignTx));
  });

  it('is not fooled by a wallet that borrows the device’s fingerprint', async () => {
    const wallet = walletFor();
    // Same fingerprint, someone else's key.
    wallet.cosigners[0] = { ...wallet.cosigners[0], xpub: accountXpub(MNEMONICS[3], 'mainnet') };
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /is not the one in this wallet/
    );
    assert.ok(!device.typesReceived().includes(M.MessageType.SignTx));
  });

  it('reports a refusal on the device as a cancellation', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    device.onButton = 'reject';
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      UserCancelled
    );
    device.onButton = 'confirm';
    const signatures = await trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint });
    assert.equal(signatures.length, 1);
  });

  it('takes the question off the screen when nobody answers it', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    device.onButton = 'walk-away';
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /did not answer in time/
    );
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
    device.onButton = 'confirm';
    assert.equal((await trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint })).length, 1);
  });

  /** A device that behaves until it comes to answer with a TxRequest, which `change` then alters. */
  const meddling = (change: (request: Message, nth: number) => void) => {
    const device = new SimulatedTrezor(SEED);
    let nth = 0;
    const honest = (device as any).deliver.bind(device);
    (device as any).deliver = (reply: Wire) => {
      if (reply.type === M.MessageType.TxRequest) change(reply.message, nth++);
      honest(reply);
    };
    return device;
  };

  const misbehaviour: [string, (request: Message, nth: number) => void, RegExp][] = [
    [
      'signs something else',
      (request) => {
        if (!request.serialized?.signature) return;
        const other = Buffer.from(ecc.sign(Buffer.alloc(32, 1), Buffer.alloc(32, 2)));
        const der = bitcoin.script.signature.encode(other, 1);
        request.serialized.signature = Buffer.from(der.subarray(0, der.length - 1));
      },
      /does not match this transaction and key/,
    ],
    [
      'returns a signature that is not DER',
      (request) => {
        if (request.serialized?.signature) request.serialized.signature = Buffer.alloc(64, 1);
      },
      /cannot read/,
    ],
    [
      'leaves an input unsigned',
      (request) => {
        if (request.request_type === M.RequestType.TXFINISHED) delete request.serialized;
      },
      /did not sign input 2/,
    ],
    [
      'signs an input that does not exist',
      (request) => {
        if (request.serialized?.signature) request.serialized.signature_index = 7;
      },
      /signed an input this transaction does not have/,
    ],
    [
      'asks about a transaction that is not being spent from',
      (request) => {
        if (request.details?.tx_hash) request.details.tx_hash = Buffer.alloc(32, 9);
      },
      /does not spend from/,
    ],
    [
      'asks for an input past the end',
      (request, nth) => {
        if (nth === 0) request.details.request_index = 40;
      },
      /does not have/,
    ],
    [
      'asks for something only other coins have',
      (request, nth) => {
        if (nth === 0) request.request_type = M.RequestType.TXEXTRADATA;
      },
      /does not have/,
    ],
  ];
  for (const [what, change, expected] of misbehaviour) {
    it(`gives up on a device that ${what}`, async () => {
      const wallet = walletFor();
      const psbt = fundedPsbt(wallet, [60_000, 45_000], 80_000);
      const device = meddling(change);
      const { trezor } = driverFor(device);
      await trezor.connect();
      await assert.rejects(
        trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
        expected
      );
    });
  }

  it('calls the device off when it is the one to give up mid-transaction', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = meddling((request, nth) => {
      if (nth === 0) request.details.request_index = 40;
    });
    const { trezor } = driverFor(device);
    await trezor.connect();
    await assert.rejects(trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }));
    assert.equal(device.typesReceived().at(-1), M.MessageType.Cancel);
  });

  it('does not follow a device round in circles', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    device.override = (incoming) =>
      incoming.type === M.MessageType.SignTx || incoming.type === M.MessageType.TxAck
        ? [{ type: M.MessageType.TxRequest, message: { request_type: 0, details: { request_index: 0 } } }]
        : null;
    await assert.rejects(
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      /kept asking for the same things/
    );
  });

  it('runs one command at a time', async () => {
    const wallet = walletFor();
    const psbt = fundedPsbt(wallet, [60_000], 30_000);
    const device = new SimulatedTrezor(SEED);
    const { trezor } = driverFor(device);
    await trezor.connect();
    const [signatures, key] = await Promise.all([
      trezor.signMultisig({ wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint }),
      trezor.getKey('testnet'),
    ]);
    assert.equal(signatures.length, 1);
    assert.equal(key.xpub, accountXpub(SEED, 'testnet'));
    // The key was asked for only once signing had finished.
    const types = device.typesReceived();
    assert.ok(types.lastIndexOf(M.MessageType.TxAck) < types.lastIndexOf(M.MessageType.GetPublicKey));
  });
});

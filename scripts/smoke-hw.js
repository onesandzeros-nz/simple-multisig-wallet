// Hardware wallet drivers under RN globals. Each device's protocol is run
// against a stand-in for the device, through the same path the app takes: prove
// the key, fetch the previous transactions, sign, verify, attach — then a
// second cosigner finishes the transaction. Buffer range handling is
// everywhere in this code, which is exactly what differs on Hermes.
import { accountXpub, masterFingerprint } from '../src/lib/bitcoin';
import { buildPsbt, finalizeAndExtract, parsePsbt, signPsbtWithMnemonic } from '../src/lib/wallet';
import { readKeyFromDevice, signPsbtWithDevice, withPreviousTransactions } from '../src/lib/hw/sign';
import { decodeMessage, encodeMessage } from '../src/lib/hw/protobuf';
import { LedgerDevice } from '../src/lib/hw/ledger';
import { TrezorDevice } from '../src/lib/hw/trezor';
import { planSigning } from '../src/lib/hw/bitbox02/signing';
import { encodeRequest } from '../src/lib/hw/bitbox02/messages';
import { encodeFrame, HWW_CMD } from '../src/lib/hw/bitbox02/u2fhid';
import { generateKeypair, NoiseInitiator, pairingCode, PROTOCOL_NAME } from '../src/lib/hw/bitbox02/noise';
import { hostCommitment, newHostNonce } from '../src/lib/hw/bitbox02/antiklepto';
import { FakeLedgerApp, packetTransport } from '../tests/hwLedgerHarness';
import { SimulatedTrezor } from '../tests/hwTrezorSimulator';
import { MNEMONICS, makeWallet, makeFundedSnapshot, DEST_MAINNET } from '../tests/helpers';

const prompts = {
  status() {},
  pinMatrix: async () => '1',
  passphrase: async () => '',
  confirmPairing: async () => true,
};

function memory() {
  const store = new Map();
  return { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) };
}

/** Key out, signatures in, transaction finalised — for one driver. */
async function roundTrip(name, device, seed) {
  await device.connect();
  const key = await readKeyFromDevice(device, 'mainnet');
  if (key.xpub !== accountXpub(seed, 'mainnet')) throw new Error(`${name}: xpub mismatch`);
  if (key.fingerprint !== masterFingerprint(seed)) throw new Error(`${name}: fingerprint mismatch`);

  const wallet = makeWallet(2, [seed, MNEMONICS[1], MNEMONICS[2]]);
  const { snapshot, transactions } = makeFundedSnapshot(wallet, [60000, 45000]);
  const draft = buildPsbt(wallet, snapshot, DEST_MAINNET, 80000, 5, false).psbt.toBase64();
  const signed = await signPsbtWithDevice({
    device,
    wallet,
    psbtBase64: draft,
    fetchTx: async (_network, txid) => transactions.get(txid),
  });
  if (signed.signedInputs !== 2) throw new Error(`${name}: expected two signatures`);
  const psbt = parsePsbt(signed.base64, 'mainnet');
  signPsbtWithMnemonic(psbt, MNEMONICS[1], wallet);
  if (!finalizeAndExtract(psbt)) throw new Error(`${name}: transaction did not finalise`);
  await device.close();
}

export async function hardwareWalletSmoke() {
  const schema = { path: { id: 1, type: 'uint32', repeated: true, packed: true }, blob: { id: 2, type: 'bytes' } };
  const back = decodeMessage(schema, encodeMessage(schema, { path: [0x80000030, 7], blob: Buffer.from('beef', 'hex') }));
  if (back.path[0] !== 0x80000030 || back.blob.toString('hex') !== 'beef') throw new Error('protobuf round trip failed');

  const seed = MNEMONICS[0];
  const app = new FakeLedgerApp({ mnemonic: seed });
  await roundTrip(
    'ledger',
    new LedgerDevice(packetTransport(app.exchange), { prompts, memory: memory() }, { productId: 0x5011 }),
    seed
  );
  if (app.registrations.length !== 1) throw new Error('ledger: wallet was not registered');

  const trezor = new SimulatedTrezor(seed);
  trezor.features = { ...trezor.features, passphrase_protection: false };
  await roundTrip('trezor', new TrezorDevice(trezor, { prompts, memory: memory() }), seed);

  // BitBox02: no stand-in device is small enough to carry here, so its parts
  // are run one by one — the plan it would walk the device through, the
  // message and frame encodings, and the opening of the encrypted channel.
  const wallet = makeWallet(2, [seed, MNEMONICS[1], MNEMONICS[2]]);
  const { snapshot, transactions } = makeFundedSnapshot(wallet, [60000, 45000]);
  const psbt = buildPsbt(wallet, snapshot, DEST_MAINNET, 80000, 5, false).psbt;
  await withPreviousTransactions(psbt, 'mainnet', async (_network, txid) => transactions.get(txid));
  const plan = planSigning(
    { wallet, psbt, fingerprint: wallet.cosigners[0].fingerprint },
    { ownReceiveOutputs: true, opReturnOutputs: true }
  );
  if (plan.inputs.length !== 2 || plan.outputs.filter((o) => o.ours).length !== 1) {
    throw new Error('bitbox02: signing plan is wrong');
  }
  const frames = encodeFrame(HWW_CMD, encodeRequest({ btc_sign_init: plan.init }));
  if (frames.length < 2 || frames.some((f) => f.length !== 64)) throw new Error('bitbox02: framing is wrong');
  const noise = new NoiseInitiator(generateKeypair(), Buffer.from(PROTOCOL_NAME, 'ascii'));
  if (noise.writeFirst().length !== 32) throw new Error('bitbox02: handshake opening is wrong');
  if (!/^[A-Z2-7]{5} [A-Z2-7]{5}\n[A-Z2-7]{5} [A-Z2-7]{5}$/.test(pairingCode(Buffer.alloc(32, 7)))) {
    throw new Error('bitbox02: pairing code is malformed');
  }
  if (hostCommitment(newHostNonce()).length !== 32) throw new Error('bitbox02: anti-klepto commitment is wrong');
}

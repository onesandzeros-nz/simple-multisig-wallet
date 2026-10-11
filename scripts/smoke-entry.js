// Entry for the RN-environment smoke test: import the polyfills the same
// way index.ts does, then exercise every engine module at runtime.
import '../polyfills';
import { generateMnemonic, masterFingerprint, accountXpub, bip48Path, deriveAddress, walletDescriptor } from '../src/lib/bitcoin';
import { buildPsbt, signPsbtWithMnemonic, summarisePsbt, finalizeAndExtract, parsePsbt } from '../src/lib/wallet';
import { normaliseXpub } from '../src/lib/slip132';
import { parseWalletImportText } from '../src/lib/walletImport';
import { createQrAssembler } from '../src/lib/qrParts';
import { createPsbtUrEncoder } from '../src/lib/qrExport';
import { extractPsbt } from '../src/lib/psbtFromBytes';
import { generateSecretKey, signEvent, verifyEvent, encryptPayload, decryptPayload, channelId } from '../src/lib/nostr/crypto';
import { nostrSecretFromMnemonic, nostrSecretForGroup, npubFromSecret } from '../src/lib/nostr/identity';
import { encodeInvite, parseInvite } from '../src/lib/nostr/protocol';
import { hardwareWalletSmoke } from './smoke-hw';

const mnemonics = [generateMnemonic(), generateMnemonic()];
const cosigners = mnemonics.map((m, i) => ({
  name: `s${i}`,
  fingerprint: masterFingerprint(m),
  path: bip48Path('mainnet'),
  xpub: accountXpub(m, 'mainnet'),
}));
normaliseXpub(cosigners[0].xpub);

const wallet = {
  id: 't', name: 't', m: 2, n: 2, network: 'mainnet', scriptType: 'P2WSH',
  cosigners, createdAt: 0,
};
const addr = deriveAddress(wallet, 0, 0);
walletDescriptor(wallet);

const snapshot = {
  confirmedSats: 100000, unconfirmedSats: 0,
  utxos: [{ txid: 'cc'.repeat(32), vout: 0, value: 100000, address: addr.address, branch: 0, index: 0, confirmed: true }],
  usedAddresses: [], nextReceiveIndex: 1, nextChangeIndex: 0, scannedAt: 0,
};
const built = buildPsbt(wallet, snapshot, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 40000, 5, false);
const copy = parsePsbt(built.psbt.toBase64(), 'mainnet');
signPsbtWithMnemonic(copy, mnemonics[0], wallet);
signPsbtWithMnemonic(copy, mnemonics[1], wallet);
if (!summarisePsbt(copy, wallet).complete) throw new Error('psbt not complete');
finalizeAndExtract(copy);

// Wallet import + QR assembly paths (exercises bc-ur/cbor under RN globals).
const imported = parseWalletImportText(walletDescriptor(wallet));
if (imported.m !== 2) throw new Error('descriptor import mismatch');
const asm = createQrAssembler();
asm.receive('p1of2 foo');
const qr = asm.receive('p2of2 bar');
if (qr.text !== 'foobar') throw new Error('qr assembly mismatch');

// Full BC-UR round trip (cbor-sync, crc, sha.js all run under RN globals).
const { UR, UREncoder } = require('@ngraveio/bc-ur');
const urFrame = new UREncoder(UR.fromBuffer(Buffer.from('ur smoke', 'utf8')), 10000).nextPart();
const urResult = createQrAssembler().receive(urFrame);
if (urResult.text !== 'ur smoke') throw new Error('ur decode mismatch');

// Nostr layer under RN globals (schnorr, xchacha20poly1305, bech32).
const groupSecret = generateSecretKey();
const nsec = nostrSecretForGroup(mnemonics[0], groupSecret);
if (!npubFromSecret(nsec).startsWith('npub1')) throw new Error('npub encoding failed');
if (nsec === nostrSecretFromMnemonic(mnemonics[0])) throw new Error('group identity must differ from NIP-06 account 0');
const sealed = encryptPayload(groupSecret, 'hello group');
if (decryptPayload(groupSecret, sealed) !== 'hello group') throw new Error('group crypto failed');
const ev = signEvent(nsec, { created_at: 1700000000, kind: 9797, tags: [['t', channelId(groupSecret)]], content: sealed });
if (!verifyEvent(ev)) throw new Error('event signing failed');
const inviteBack = parseInvite(
  encodeInvite({ secret: groupSecret, relays: ['wss://r'], name: 'G', m: 2, n: 3 })
);
if (inviteBack.secret !== groupSecret || inviteBack.m !== 2 || inviteBack.n !== 3) {
  throw new Error('invite round trip failed');
}

// Animated PSBT QR export/import under RN globals.
const psbtEncoder = createPsbtUrEncoder(copy.toBase64());
const psbtAsm = createQrAssembler();
let psbtResult;
for (let i = 0; i < 200; i++) {
  psbtResult = psbtAsm.receive(psbtEncoder.nextPart());
  if (psbtResult.done) break;
}
if (psbtResult?.text !== copy.toBase64()) throw new Error('psbt qr round trip failed');

// NFC read from a Coldcard: a text record, a checksum, then the binary PSBT.
// Buffer range handling here is species-sensitive, hence the smoke test.
const tag = [
  Buffer.concat([Buffer.from([0x02]), Buffer.from('enPartly signed.psbt', 'utf8')]),
  Buffer.alloc(32, 7),
  Buffer.from(copy.toBase64(), 'base64'),
];
if (extractPsbt(tag, 'mainnet') !== copy.toBase64()) throw new Error('nfc psbt extract failed');

// Hardware wallet drivers talk in turns, so this part finishes later; the
// runner waits for it.
globalThis.__SMOKE_ASYNC__ = hardwareWalletSmoke();

globalThis.__SMOKE_OK__ = true;

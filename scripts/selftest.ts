/**
 * Functional self-test of the wallet engine (run with: npm run selftest).
 * Exercises key generation, derivation, descriptors and the full
 * build → sign → combine → finalize PSBT flow without any UI.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { descriptorChecksum } from '../src/lib/descriptor';
import { normaliseXpub, parseKeyExpression } from '../src/lib/slip132';
import {
  accountXpub,
  bip48Path,
  deriveAddress,
  generateMnemonic,
  masterFingerprint,
  rootFromMnemonic,
  walletDescriptor,
  walletConfigFile,
  multisigInputVbytes,
} from '../src/lib/bitcoin';
import { buildPsbt, summarisePsbt, signPsbtWithMnemonic, finalizeAndExtract, parsePsbt } from '../src/lib/wallet';
import { MultisigWallet, WalletSnapshot } from '../src/lib/types';

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// 1. Descriptor checksum against the Bitcoin Core documentation test vector.
const coreVector =
  'wpkh([d34db33f/84h/0h/0h]xpub6DJ2dNUysrn5Vt36jH2KLBT2i1auw1tTSSomg8PhqNiUtx8QX2SvC9nrHu81fT41fvDUnhMjEzQgXnQjKEu3oaqMSzhSrHMxyyoEAmUHQbY/0/*)';
check('descriptor checksum matches Bitcoin Core vector', descriptorChecksum(coreVector) === 'cjjspncu', descriptorChecksum(coreVector));

// 2. SLIP-132 normalisation: convert a Zpub and make sure it round-trips to xpub.
const abandonMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const abandonXpub = accountXpub(abandonMnemonic, 'mainnet');
check('BIP48 mainnet path', bip48Path('mainnet') === "m/48'/0'/0'/2'");
check(
  'known mnemonic fingerprint (BIP84 test vector wallet)',
  masterFingerprint(abandonMnemonic) === '73c5da0a',
  masterFingerprint(abandonMnemonic)
);
check('xpub normalises to itself', normaliseXpub(abandonXpub).xpub === abandonXpub);
try {
  const priv = rootFromMnemonic(abandonMnemonic, 'mainnet').toBase58();
  normaliseXpub(priv);
  check('rejects xprv import', false);
} catch {
  check('rejects xprv import', true);
}

// 2b. Descriptor key expressions: [fingerprint/path]xpub/child/*.
const expr = parseKeyExpression(`[73C5DA0A/48h/0h/0h/2h]${abandonXpub}/<0;1>/*`);
check('key expression: xpub extracted', expr.xpub === abandonXpub);
check('key expression: fingerprint lowercased', expr.fingerprint === '73c5da0a');
check("key expression: h-path normalised to m/48'/0'/0'/2'", expr.path === "m/48'/0'/0'/2'", expr.path);
const bare = parseKeyExpression(abandonXpub);
check('key expression: bare xpub still works', bare.xpub === abandonXpub && !bare.fingerprint);
check('key expression: /0/* suffix accepted', parseKeyExpression(`${abandonXpub}/0/*`).xpub === abandonXpub);
try {
  parseKeyExpression(`[73C5DA0A/48h]${abandonXpub}/0h/*`);
  check('key expression: rejects hardened child path', false);
} catch {
  check('key expression: rejects hardened child path', true);
}
try {
  parseKeyExpression(`[73C5/48h]${abandonXpub}`);
  check('key expression: rejects malformed origin', false);
} catch {
  check('key expression: rejects malformed origin', true);
}

// 3. Build a 2-of-3 wallet from three local mnemonics.
const mnemonics = [abandonMnemonic, generateMnemonic(), generateMnemonic()];
const cosigners = mnemonics.map((m, i) => ({
  name: `signer ${i + 1}`,
  fingerprint: masterFingerprint(m),
  path: bip48Path('mainnet'),
  xpub: accountXpub(m, 'mainnet'),
}));
const wallet: MultisigWallet = {
  id: 'test',
  kind: 'private',
  name: 'Test wallet',
  m: 2,
  n: 3,
  network: 'mainnet',
  scriptType: 'P2WSH',
  cosigners,
  createdAt: 0,
};

const addr0 = deriveAddress(wallet, 0, 0);
check('derives bc1q… P2WSH address', addr0.address.startsWith('bc1q') && addr0.address.length === 62, addr0.address);

// Address must not depend on cosigner order (BIP67 sorting).
const shuffled: MultisigWallet = { ...wallet, cosigners: [cosigners[2], cosigners[0], cosigners[1]] };
check('BIP67: cosigner order does not change addresses', deriveAddress(shuffled, 0, 0).address === addr0.address);

const desc = walletDescriptor(wallet);
check('descriptor is wsh(sortedmulti(2,…)) with checksum', /^wsh\(sortedmulti\(2,.*\)\)#[a-z0-9]{8}$/.test(desc));
check('config file has all fingerprints', cosigners.every((c) => walletConfigFile(wallet).includes(c.fingerprint.toUpperCase())));

// 4. Full PSBT flow with a fake UTXO paying to our address 0/0.
const fakeSnapshot: WalletSnapshot = {
  confirmedSats: 150_000,
  unconfirmedSats: 0,
  utxos: [
    { txid: 'aa'.repeat(32), vout: 0, value: 100_000, address: addr0.address, branch: 0, index: 0, confirmed: true },
    { txid: 'bb'.repeat(32), vout: 1, value: 50_000, address: deriveAddress(wallet, 0, 1).address, branch: 0, index: 1, confirmed: true },
  ],
  usedAddresses: [],
  nextReceiveIndex: 2,
  nextChangeIndex: 0,
  scannedAt: 0,
};

const dest = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // BIP173 test vector address
const built = buildPsbt(wallet, fakeSnapshot, dest, 120_000, 10, false);
check('coin selection picked both coins', built.usedUtxos.length === 2);
check('has change output', built.changeSats > 0, `change=${built.changeSats} fee=${built.feeSats}`);

const summary0 = summarisePsbt(built.psbt, wallet);
check('summary: 0 of 2 signatures', summary0.signedBy.length === 0 && !summary0.complete);
check('summary: fee matches builder', summary0.fee === built.feeSats, `${summary0.fee}`);
check('summary: change flagged', summary0.outputs.some((o) => o.isChange));

// Signer 1 signs their copy, signer 2 signs another copy, then we merge.
const copy1 = parsePsbt(built.psbt.toBase64(), 'mainnet');
const copy2 = parsePsbt(built.psbt.toBase64(), 'mainnet');
check('signer 1 signs 2 inputs', signPsbtWithMnemonic(copy1, mnemonics[0], wallet) === 2);
check('signer 2 signs 2 inputs', signPsbtWithMnemonic(copy2, mnemonics[1], wallet) === 2);
check('signer 1 alone is not complete', !summarisePsbt(copy1, wallet).complete);

copy1.combine(copy2);
const merged = summarisePsbt(copy1, wallet);
check('merged copy is complete (2 of 2 required sigs)', merged.complete);
check('merged signedBy lists both fingerprints', merged.signedBy.length === 2, merged.signedBy.join(','));

const hex = finalizeAndExtract(copy1);
const tx = bitcoin.Transaction.fromHex(hex);
check('finalizes to a valid transaction', tx.ins.length === 2 && tx.outs.length === 2);
check(
  'real vsize ≤ estimated vsize (fee never underpaid)',
  tx.virtualSize() <= Math.ceil(built.feeSats / 10),
  `real=${tx.virtualSize()} estimated=${Math.ceil(built.feeSats / 10)}`
);
check('input vbytes estimate sane for 2-of-3', multisigInputVbytes(2, 3) > 100 && multisigInputVbytes(2, 3) < 130, String(multisigInputVbytes(2, 3)));

// 5. Send-max path.
const maxBuild = buildPsbt(wallet, fakeSnapshot, dest, 0, 5, true);
check('send-max has single output, no change', maxBuild.psbt.txOutputs.length === 1 && maxBuild.changeSats === 0);
check('send-max amount + fee = total', maxBuild.psbt.txOutputs[0].value + maxBuild.feeSats === 150_000);

console.log(failures === 0 ? '\n🎉 all checks passed' : `\n💥 ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

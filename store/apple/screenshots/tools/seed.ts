import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  accountXpub, bip48Path, deriveAddress, masterFingerprint, mnemonicFromDiceRolls,
} from '../../../../src/lib/bitcoin';
import { buildPsbt } from '../../../../src/lib/wallet';
import type { MultisigWallet, SignerKey, Cosigner, WalletSnapshot, Utxo } from '../../../../src/lib/types';

const OUT = process.argv[2];
const LOCAL_KEY_ID = process.env.LOCAL_KEY_ID || '';
const PORT = 18443;
const NET = 'mainnet' as const;

const rolls = (label: string) => {
  // 60 digits 1-6, deterministic from the label.
  let s = ''; let i = 0;
  while (s.length < 60) { const h = createHash('sha256').update(label + i++).digest(); for (const b of h) { if (s.length < 60) s += String((b % 6) + 1); } }
  return s;
};
const mn = (label: string) => mnemonicFromDiceRolls(rolls(label));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const day = (y: number, m: number, d: number, h = 2) => Math.floor(Date.UTC(y, m - 1, d, h) / 1000);
const ms = (y: number, m: number, d: number, h = 2) => Date.UTC(y, m - 1, d, h);

const localMnemonic = mn('rob-phone');
const localXpub = accountXpub(localMnemonic, NET);
const localFp = masterFingerprint(localMnemonic);

type K = { id: string; name: string; label: string; source?: 'tapsigner'; createdAt: number };
const imported: K[] = [
  { id: 'k-coldcard', name: 'Coldcard', label: 'coldcard', createdAt: ms(2026, 6, 14) },
  { id: 'k-tapsigner', name: 'TAPSIGNER', label: 'tapsigner', source: 'tapsigner', createdAt: ms(2026, 6, 20) },
  { id: 'k-jade', name: 'Jade', label: 'jade', createdAt: ms(2026, 7, 2) },
  { id: 'k-bitbox', name: 'BitBox02', label: 'bitbox', createdAt: ms(2026, 7, 30) },
  { id: 'k-mia', name: "Mia's phone", label: 'mia', createdAt: ms(2026, 8, 3) },
  { id: 'k-sam', name: "Sam's phone", label: 'sam', createdAt: ms(2026, 8, 3, 5) },
];
const keys: SignerKey[] = imported.filter((k) => !['k-mia', 'k-sam'].includes(k.id)).map((k) => ({
  id: k.id, name: k.name, type: 'imported', fingerprint: masterFingerprint(mn(k.label)),
  xpub: accountXpub(mn(k.label), NET), path: bip48Path(NET), network: NET, createdAt: k.createdAt,
  ...(k.source ? { source: k.source } : {}),
}));
const byId = Object.fromEntries(imported.map((k) => [k.id, { id: k.id, name: k.name, fingerprint: masterFingerprint(mn(k.label)), xpub: accountXpub(mn(k.label), NET), path: bip48Path(NET) }]));

const cos = (ids: string[]): Cosigner[] => ids.map((id) => id === 'local'
  ? { name: "Rob's phone", fingerprint: localFp, path: bip48Path(NET), xpub: localXpub, ...(LOCAL_KEY_ID ? { keyId: LOCAL_KEY_ID } : {}) }
  : { name: byId[id].name, fingerprint: byId[id].fingerprint, path: byId[id].path!, xpub: byId[id].xpub!, ...(keys.some((k) => k.id === id) ? { keyId: id } : {}) });

const wallet = (id: string, name: string, kind: 'private' | 'group', m: number, ids: string[], createdAt: number, extra: Partial<MultisigWallet> = {}): MultisigWallet => ({
  id, name, kind, m, n: ids.length, network: NET, scriptType: 'P2WSH', cosigners: cos(ids), createdAt,
  exportedAt: createdAt + 3600_000, backupVerifiedAt: createdAt + 7200_000, ...extra,
});

const wallets: MultisigWallet[] = [
  wallet('w-family', 'Family savings', 'private', 2, ['local', 'k-coldcard', 'k-tapsigner'], ms(2026, 6, 21)),
  wallet('w-studio', 'Studio treasury', 'group', 3, ['local', 'k-mia', 'k-sam', 'k-coldcard', 'k-jade'], ms(2026, 8, 4), { backupIncludesGroup: true }),
  wallet('w-holiday', 'Holiday fund', 'group', 2, ['local', 'k-mia', 'k-jade'], ms(2026, 9, 12), { backupIncludesGroup: true }),
  wallet('w-emergency', 'Emergency fund', 'private', 2, ['local', 'k-bitbox', 'k-coldcard'], ms(2026, 7, 31)),
];

// ---- fake chain -----------------------------------------------------------
type Tx = { txid: string; fee: number; status: any; vin: any[]; vout: any[] };
const chain: Record<string, { stats: any; utxos: any[]; txs: Tx[] }> = {};
const entry = (a: string) => (chain[a] ??= { stats: { address: a, chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }, utxos: [], txs: [] });
const TIP = 964_812;
const heightFor = (t: number) => TIP - Math.round((day(2026, 10, 16, 20) - t) / 600);
const EXTERNAL = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const snapshots: Record<string, WalletSnapshot> = {};

function receive(w: MultisigWallet, index: number, value: number, t: number, label: string) {
  const { address } = deriveAddress(w, 0, index);
  const txid = sha(`${w.id}:${label}`);
  const e = entry(address);
  const status = { confirmed: true, block_height: heightFor(t), block_time: t };
  e.txs.push({ txid, fee: 640, status, vin: [{ prevout: { scriptpubkey_address: 'bc1q' + sha(label).slice(0, 38), value: value + 640 } }], vout: [{ scriptpubkey_address: address, value }] });
  e.utxos.push({ txid, vout: 0, value, status: { confirmed: true, block_height: status.block_height } });
  e.stats.chain_stats.funded_txo_sum += value; e.stats.chain_stats.tx_count += 1;
  return { txid, address };
}
function spend(w: MultisigWallet, from: { txid: string; address: string; value: number }, amount: number, fee: number, changeIndex: number, t: number, label: string) {
  const change = deriveAddress(w, 1, changeIndex).address;
  const txid = sha(`${w.id}:${label}`);
  const status = { confirmed: true, block_height: heightFor(t), block_time: t };
  const tx: Tx = { txid, fee, status, vin: [{ prevout: { scriptpubkey_address: from.address, value: from.value } }], vout: [{ scriptpubkey_address: EXTERNAL, value: amount }, { scriptpubkey_address: change, value: from.value - amount - fee }] };
  const src = entry(from.address);
  src.txs.push(tx); src.utxos = src.utxos.filter((u) => u.txid !== from.txid);
  src.stats.chain_stats.spent_txo_sum += from.value; src.stats.chain_stats.tx_count += 1;
  const ch = entry(change);
  ch.txs.push(tx); ch.utxos.push({ txid, vout: 1, value: from.value - amount - fee, status: { confirmed: true, block_height: status.block_height } });
  ch.stats.chain_stats.funded_txo_sum += from.value - amount - fee; ch.stats.chain_stats.tx_count += 1;
}
function snapshotFor(w: MultisigWallet): WalletSnapshot {
  const utxos: Utxo[] = [];
  let nextReceive = 0, nextChange = 0;
  for (const branch of [0, 1] as const) for (let i = 0; i < 20; i++) {
    const { address } = deriveAddress(w, branch, i);
    const e = chain[address]; if (!e) continue;
    if (branch === 0) nextReceive = i + 1; else nextChange = i + 1;
    for (const u of e.utxos) utxos.push({ txid: u.txid, vout: u.vout, value: u.value, address, branch, index: i, confirmed: true, blockHeight: u.status.block_height });
  }
  return { confirmedSats: utxos.reduce((s, u) => s + u.value, 0), unconfirmedSats: 0, utxos, usedAddresses: [], nextReceiveIndex: nextReceive, nextChangeIndex: nextChange, scannedAt: Date.now() };
}

const [wFamily, wStudio, wHoliday, wEmergency] = wallets;
receive(wFamily, 0, 1_250_000, day(2026, 9, 3), 'r0');
receive(wFamily, 1, 500_000, day(2026, 9, 20), 'r1');
const s0 = receive(wStudio, 0, 2_000_000, day(2026, 8, 12), 'r0');
receive(wStudio, 1, 1_500_000, day(2026, 9, 1), 'r1');
spend(wStudio, { ...s0, value: 2_000_000 }, 400_000, 1_000, 0, day(2026, 9, 28), 's0');
receive(wStudio, 2, 250_000, day(2026, 10, 9), 'r2');
receive(wHoliday, 0, 320_000, day(2026, 10, 2), 'r0');
receive(wEmergency, 0, 5_000_000, day(2026, 7, 15), 'r0');
for (const w of wallets) snapshots[w.id] = snapshotFor(w);

// A draft spend from the studio wallet, waiting for signatures.
const draft = buildPsbt(wStudio, snapshots['w-studio'], EXTERNAL, 400_000, 8, false);
const pending = [{ id: 'p-studio-1', walletId: 'w-studio', base64: draft.psbt.toBase64(), memo: 'Printer invoice for October', createdAt: ms(2026, 10, 15, 21), updatedAt: ms(2026, 10, 15, 21) }];

const groups = [
  { id: 'g-studio', name: 'Studio treasury', relays: [], identityKeyId: LOCAL_KEY_ID || 'missing', m: 3, n: 5, network: NET, contributedKeyIds: LOCAL_KEY_ID ? [LOCAL_KEY_ID] : [], coordinator: true, walletId: 'w-studio', createdAt: ms(2026, 8, 3), lastReadChatAt: ms(2026, 10, 15, 20), lastSeenTxAt: ms(2026, 10, 15, 22), currentEpoch: 1, rekey: true },
  { id: 'g-holiday', name: 'Holiday fund', relays: [], identityKeyId: LOCAL_KEY_ID || 'missing', m: 2, n: 3, network: NET, contributedKeyIds: LOCAL_KEY_ID ? [LOCAL_KEY_ID] : [], coordinator: false, walletId: 'w-holiday', createdAt: ms(2026, 9, 11), lastReadChatAt: ms(2026, 10, 16), lastSeenTxAt: ms(2026, 10, 16), currentEpoch: 1, rekey: true },
];
const pk = (s: string) => sha('pk' + s);
const chats = [
  { id: 'c1', groupId: 'g-studio', author: pk('mia'), name: 'Mia', text: 'Printer invoice is in: 400,000 sats. I have made the transaction and signed it.', mine: false, at: ms(2026, 10, 15, 21, ) },
  { id: 'c2', groupId: 'g-studio', author: pk('rob'), name: 'Rob', text: 'Looks right to me. Signing from my phone now.', mine: true, at: ms(2026, 10, 15, 21) + 600_000 },
  { id: 'c3', groupId: 'g-studio', author: pk('sam'), name: 'Sam', text: "I'll add the Coldcard signature tonight and it can go out.", mine: false, at: ms(2026, 10, 15, 22) },
  { id: 'c4', groupId: 'g-studio', author: pk('mia'), name: 'Mia', text: 'Thanks both. That leaves plenty for the rent on the 1st.', mine: false, at: ms(2026, 10, 15, 22) + 900_000 },
  { id: 'c5', groupId: 'g-holiday', author: pk('mia'), name: 'Mia', text: 'Flights are booked. Can we top this up by the end of the month?', mine: false, at: ms(2026, 10, 10, 6) },
];

const settings = {
  darkMode: false, publicServerId: 'blockstream', ownBackend: { kind: 'esplora', url: `http://localhost:${PORT}` }, useOwnServer: true,
  identityKeyId: LOCAL_KEY_ID || null, relays: [], publicRelays: false, testnet: false, securityMode: false, userName: 'Rob', wipeLeftovers: [],
};

const manifest: Record<string, string> = {
  'sms.keys.v1': JSON.stringify(keys), // the local key record is merged in by the shell step
  'sms.wallets.v1': JSON.stringify(wallets),
  'sms.pending.v1': JSON.stringify(pending),
  'sms.settings.v1': JSON.stringify(settings),
  'sms.groups.v1': JSON.stringify(groups),
  'sms.chats.v1': JSON.stringify(chats),
};
writeFileSync(`${OUT}/manifest.seed.json`, JSON.stringify(manifest));
writeFileSync(`${OUT}/chain.json`, JSON.stringify({ tip: TIP, addresses: chain }));
console.log('MNEMONIC', localMnemonic);
console.log('FINGERPRINT', localFp);
for (const w of wallets) console.log(w.name, snapshots[w.id].confirmedSats, 'sats, utxos', snapshots[w.id].utxos.length);
console.log('draft fee', draft.feeSats, 'inputs', draft.usedUtxos.length);

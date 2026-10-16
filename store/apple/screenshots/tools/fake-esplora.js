// A tiny Esplora/mempool-compatible server answering from chain.json.
const http = require('http'); const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, 'chain.json');
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const empty = (a) => ({ address: a, chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
http.createServer((req, res) => {
  const data = load(); const u = req.url.replace(/^\/testnet/, '');
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  let m;
  if (u === '/api/blocks/tip/height') { res.writeHead(200); return res.end(String(data.tip)); }
  if (u === '/api/v1/fees/recommended') return json({ fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 3, minimumFee: 1 });
  if (u === '/api/fee-estimates') return json({ '1': 12, '2': 12, '3': 8, '4': 8, '5': 6, '6': 5, '10': 4, '12': 3, '25': 2, '144': 1.5, '504': 1, '1008': 1 });
  if ((m = u.match(/^\/api\/address\/([a-z0-9]+)\/utxo$/))) return json((data.addresses[m[1]] || {}).utxos || []);
  if ((m = u.match(/^\/api\/address\/([a-z0-9]+)\/txs$/))) return json((data.addresses[m[1]] || {}).txs || []);
  if ((m = u.match(/^\/api\/address\/([a-z0-9]+)$/))) return json((data.addresses[m[1]] || {}).stats || empty(m[1]));
  console.log('404', u); res.writeHead(404); res.end('not found');
}).listen(18443, () => console.log('fake esplora on 18443'));

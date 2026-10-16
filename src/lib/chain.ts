import {
  broadcastTx as esploraBroadcast,
  DEFAULT_SERVER as DEFAULT_ESPLORA_SERVER,
  esploraServer,
  esploraWebBase,
  fetchAddressStats,
  fetchAddressTxs,
  fetchFees as esploraFees,
  fetchTipHeightFrom,
  fetchTxHex as esploraTxHex,
  fetchUtxos,
  RecommendedFees,
  setEsploraServer,
} from './esplora';
import { ElectrumAdapter } from './electrum/adapter';
import { ElectrumClient, ElectrumSocketFactory, ElectrumTarget } from './electrum/client';
import { rnSocketFactory } from './electrum/rnSocket';
import { ChainApi } from './wallet';
import { NetworkName } from './types';

/**
 * Which server the wallet talks to. Everything above this module works
 * through one interface, so a mempool.space-compatible HTTP API and an
 * Electrum server are interchangeable.
 */
export type BackendConfig =
  | { kind: 'esplora'; url: string | null }
  | {
      kind: 'electrum';
      host: string;
      port: number;
      tls: boolean;
      /**
       * An Electrum server indexes one chain, so testnet is a separate
       * host/port. Public entries fill this in; a user's own server may not
       * have one, in which case testnet wallets talk to the mainnet target
       * (and fail loudly, as before).
       */
      testnet?: { host: string; port: number };
    };

/** A server anyone can use without running anything themselves. */
export interface PublicServer {
  id: string;
  name: string;
  /** Who runs it — shown so people know whose server sees their addresses. */
  operator: string;
  backend: BackendConfig;
  /** Whether it can serve testnet wallets as well as mainnet. */
  testnet: boolean;
}

/**
 * Public servers offered in Settings. Order matters: the first is the
 * default. blockstream.info leads because mempool.space's public API rate
 * limits a wallet scan (429s), and Blockstream's does not.
 *
 * All of them speak HTTPS. The app verifies an HTTPS server's hostname (it
 * goes through `fetch`) but cannot verify an Electrum server's over TLS
 * (SECURITY-AUDIT.md, H4), so a server reached over the open internet is
 * only offered over HTTPS; Electrum is for a server you run yourself, on a
 * network you control. Settings saved with one of the Electrum picks earlier
 * builds offered fall back to the default.
 */
export const PUBLIC_SERVERS: readonly PublicServer[] = [
  {
    id: 'blockstream',
    name: 'blockstream.info',
    operator: 'Blockstream',
    backend: { kind: 'esplora', url: 'https://blockstream.info' },
    testnet: true,
  },
  {
    id: 'mempool',
    name: 'mempool.space',
    operator: 'Mempool',
    backend: { kind: 'esplora', url: 'https://mempool.space' },
    testnet: true,
  },
  {
    id: 'emzy',
    name: 'mempool.emzy.de',
    operator: 'Emzy (community)',
    backend: { kind: 'esplora', url: 'https://mempool.emzy.de' },
    testnet: false,
  },
];

/**
 * Whether a host is one the phone reaches without crossing the open
 * internet: loopback, a private or link-local range, a CGNAT/Tailscale
 * address, a bare name, or a `.local`, `.lan`, `.home.arpa`, `.ts.net` or
 * `.onion` name. For the Electrum settings: a TLS connection to anything
 * else has a hostname the app cannot verify, and the HTTPS option should be
 * used instead. A heuristic for advice, not a security boundary — a VPN can
 * make a public name private and a split tunnel the reverse.
 */
export function looksPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' || h === 'localhost' || h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.includes(':')) return /^(fc|fd|fe[89ab])/.test(h); // IPv6: unique-local or link-local
  if (!h.includes('.')) return true; // a bare name resolves on the local network
  return /\.(local|lan|home\.arpa|internal|ts\.net|onion)$/.test(h);
}

export const DEFAULT_PUBLIC_SERVER_ID = PUBLIC_SERVERS[0].id;

export function publicServerById(id: string | null | undefined): PublicServer {
  return PUBLIC_SERVERS.find((p) => p.id === id) ?? PUBLIC_SERVERS[0];
}

export const DEFAULT_BACKEND: BackendConfig = PUBLIC_SERVERS[0].backend;

function normaliseUrl(url: string | null): string {
  return (url ?? DEFAULT_ESPLORA_SERVER).trim().replace(/\/+$/, '').toLowerCase();
}

/** True when two configs point at the same server. */
export function sameBackend(a: BackendConfig, b: BackendConfig): boolean {
  if (a.kind === 'esplora' && b.kind === 'esplora') return normaliseUrl(a.url) === normaliseUrl(b.url);
  if (a.kind === 'electrum' && b.kind === 'electrum') {
    return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.tls === b.tls;
  }
  return false;
}

/** The public entry this config corresponds to, if any. */
export function publicServerFor(c: BackendConfig): PublicServer | null {
  return PUBLIC_SERVERS.find((p) => sameBackend(p.backend, c)) ?? null;
}

export function isPublicBackend(c: BackendConfig): boolean {
  return publicServerFor(c) !== null;
}

/**
 * How the server choice is stored. The public pick and the user's own
 * server are remembered separately so switching between them loses nothing;
 * the user's own server wins whenever it is both configured and selected.
 */
export interface BackendSettings {
  publicServerId: string;
  ownBackend: BackendConfig | null;
  useOwnServer: boolean;
}

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  publicServerId: DEFAULT_PUBLIC_SERVER_ID,
  ownBackend: null,
  useOwnServer: false,
};

/** The server the wallet should actually talk to. */
export function effectiveBackend(s: BackendSettings): BackendConfig {
  if (s.useOwnServer && s.ownBackend) return s.ownBackend;
  return publicServerById(s.publicServerId).backend;
}

/**
 * Settings saved by earlier builds held one `backend` (older still: just an
 * `esploraUrl`). An untouched default becomes the new default public server;
 * a URL matching a public entry becomes that pick; anything else was the
 * user's own server and stays in use.
 */
export function migrateBackendSettings(parsed: {
  publicServerId?: unknown;
  ownBackend?: unknown;
  useOwnServer?: unknown;
  backend?: unknown;
  esploraUrl?: unknown;
}): BackendSettings {
  if (typeof parsed.publicServerId === 'string') {
    const own = parsed.ownBackend as BackendConfig | null | undefined;
    return {
      publicServerId: publicServerById(parsed.publicServerId).id,
      ownBackend: own && typeof own === 'object' ? own : null,
      useOwnServer: parsed.useOwnServer === true,
    };
  }
  const legacy = (parsed.backend as BackendConfig | undefined) ??
    (typeof parsed.esploraUrl === 'string' && parsed.esploraUrl
      ? ({ kind: 'esplora', url: parsed.esploraUrl } as BackendConfig)
      : null);
  if (!legacy || (legacy.kind === 'esplora' && !legacy.url)) return DEFAULT_BACKEND_SETTINGS;
  const pub = publicServerFor(legacy);
  if (pub) return { ...DEFAULT_BACKEND_SETTINGS, publicServerId: pub.id };
  return { publicServerId: DEFAULT_PUBLIC_SERVER_ID, ownBackend: legacy, useOwnServer: true };
}
/** Plaintext electrs/Fulcrum default. */
export const DEFAULT_ELECTRUM_PORT = 50001;
/** TLS electrs/Fulcrum default — the one we steer users toward. */
export const DEFAULT_ELECTRUM_TLS_PORT = 50002;

let config: BackendConfig = DEFAULT_BACKEND;
let client: ElectrumClient | null = null;
let adapter: ElectrumAdapter | null = null;
let adapterNetwork: NetworkName | null = null;
let socketFactory: ElectrumSocketFactory = rnSocketFactory;

/** Swaps the socket implementation — used by tests to drive a fake server. */
export function setElectrumSocketFactory(factory: ElectrumSocketFactory): void {
  socketFactory = factory;
  resetElectrum();
}

function resetElectrum(): void {
  client?.close();
  client = null;
  adapter = null;
  adapterNetwork = null;
}

export function setBackend(next: BackendConfig): void {
  config = next;
  resetElectrum();
  // The Esplora client keeps its own module state for URL building.
  setEsploraServer(next.kind === 'esplora' ? next.url : null);
}

export function currentBackend(): BackendConfig {
  return config;
}

export function backendLabel(c: BackendConfig = config): string {
  const pub = publicServerFor(c);
  if (pub) return pub.name;
  return c.kind === 'electrum'
    ? `${c.host}:${c.port}${c.tls ? ' (TLS)' : ''}`
    : (c.url ?? DEFAULT_ESPLORA_SERVER);
}

function electrumTargetOf(c: BackendConfig, network: NetworkName = 'mainnet'): ElectrumTarget {
  if (c.kind !== 'electrum') throw new Error('Not an Electrum backend.');
  if (network === 'testnet' && c.testnet) return { host: c.testnet.host, port: c.testnet.port, tls: c.tls };
  return { host: c.host, port: c.port, tls: c.tls };
}

function electrumAdapter(network: NetworkName): ElectrumAdapter {
  if (config.kind !== 'electrum') throw new Error('Not an Electrum backend.');
  // Caches inside the adapter are network-specific, so rebuild on a change.
  if (!adapter || adapterNetwork !== network) {
    client?.close();
    client = new ElectrumClient(electrumTargetOf(config, network), socketFactory);
    adapter = new ElectrumAdapter(client, network);
    adapterNetwork = network;
  }
  return adapter;
}

/** The per-address calls the wallet scanner makes. */
export const chainApi: ChainApi = {
  addressStats: (network, address) =>
    config.kind === 'electrum'
      ? electrumAdapter(network).addressStats(address)
      : fetchAddressStats(network, address),
  utxos: (network, address) =>
    config.kind === 'electrum'
      ? electrumAdapter(network).utxos(address)
      : fetchUtxos(network, address),
  addressTxs: (network, address) =>
    config.kind === 'electrum'
      ? electrumAdapter(network).addressTxs(address)
      : fetchAddressTxs(network, address),
};

export function fetchFees(network: NetworkName): Promise<RecommendedFees> {
  if (config.kind !== 'electrum') return esploraFees(network);
  return electrumAdapter(network)
    .fees()
    .catch(() => ({ fastestFee: 10, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 }));
}

/** A whole transaction as hex. Unverified — see `withPreviousTransactions`, which checks it. */
export function fetchTxHex(network: NetworkName, txid: string): Promise<string> {
  if (config.kind !== 'electrum') return esploraTxHex(network, txid);
  return electrumAdapter(network).txHex(txid);
}

export function broadcastTx(network: NetworkName, txHex: string): Promise<string> {
  if (config.kind !== 'electrum') return esploraBroadcast(network, txHex);
  return electrumAdapter(network).broadcast(txHex);
}

/** Checks a candidate backend without making it the active one. */
export async function testBackend(candidate: BackendConfig): Promise<number> {
  if (candidate.kind === 'esplora') {
    return fetchTipHeightFrom(candidate.url ?? DEFAULT_ESPLORA_SERVER);
  }
  const probe = new ElectrumClient(electrumTargetOf(candidate), socketFactory);
  try {
    const tip = await new ElectrumAdapter(probe, 'mainnet').tipHeight();
    return tip;
  } finally {
    probe.close();
  }
}

/** The explorer links open on when the wallet has no web explorer of its own. */
const MEMPOOL_WEB = 'https://mempool.space';

/**
 * Where links open. A server the user runs themselves is normally a mempool
 * instance with its own web interface, so links go there and the lookup
 * stays off the public internet. Otherwise mempool.space: the public picks
 * are chosen for their API, not their website, and an Electrum server has
 * no website at all.
 */
function explorerBase(network: NetworkName): string {
  if (config.kind === 'esplora' && config.url && !isPublicBackend(config)) {
    return esploraWebBase(network);
  }
  return network === 'mainnet' ? MEMPOOL_WEB : `${MEMPOOL_WEB}/testnet`;
}

/** Where to send someone to look at a transaction. */
export function txExplorerUrl(network: NetworkName, txid: string): string {
  // A txid usually comes from the server — never trust its shape inside a
  // URL. Anything that is not 64 hex chars degrades to the explorer root.
  const safe = /^[0-9a-f]{64}$/i.test(txid) ? txid : '';
  const base = explorerBase(network);
  return safe ? `${base}/tx/${safe}` : base;
}

/** True when the active server is one of the public ones, not the user's own. */
export function explorerIsPublic(): boolean {
  return isPublicBackend(config);
}

/** The site a transaction link opens on, for button labels. */
export function explorerName(): string {
  const base = explorerBase('mainnet');
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export type { RecommendedFees };

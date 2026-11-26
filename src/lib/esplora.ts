import { httpFetch } from './http';
import { NetworkName } from './types';

/**
 * Blockstream's public Esplora. It answers the scanner's per-address calls
 * fast and, unlike mempool.space's public API, doesn't throttle a wallet
 * refresh into 429s.
 */
export const DEFAULT_SERVER = 'https://blockstream.info';

/**
 * Server override (set from Settings). Any Esplora / mempool.space-compatible
 * instance works — self-hosted mempool, mempool.space itself, etc.
 */
let customServer: string | null = null;
/**
 * Whether to work out where the active server keeps its API rather than
 * assume the mempool.space layout. On for a server the user runs themselves
 * (see `resolveApiLayout`); off for the public ones, whose layout is known.
 */
let discoverLayout = false;

export function setEsploraServer(url: string | null, options: { discover?: boolean } = {}): void {
  customServer = url ? url.trim().replace(/\/+$/, '') : null;
  discoverLayout = customServer !== null && options.discover === true;
  // The server may have been reconfigured since it was last looked at.
  forgetApiLayouts();
}

export function esploraServer(): string {
  return customServer ?? DEFAULT_SERVER;
}

/** Where a server's API lives for a network, and which chain answered there. */
export interface ApiLayout {
  /** Everything the wallet asks for hangs off this, e.g. https://mempool.space/testnet/api */
  base: string;
  /** Hash of block 0 — identifies the chain. Null when the server would not say. */
  genesis: string | null;
}

export const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/** The mempool.space layout: mainnet at /api, testnet at /testnet/api. */
function conventionalApiBase(root: string, network: NetworkName): string {
  return network === 'mainnet' ? `${root}/api` : `${root}/testnet/api`;
}

/**
 * Where a self-hosted server might keep its API, most conventional first.
 * A mempool instance puts it under /api, with other networks under a prefix
 * (/testnet, /testnet4). A bare Esplora or electrs REST server has it at the
 * root with no prefix at all, and so does a mempool instance that indexes
 * only a test network (under /api). The address typed into Settings may
 * itself carry a path, which every candidate keeps.
 */
export function apiBaseCandidates(root: string, network: NetworkName): string[] {
  return network === 'mainnet'
    ? [`${root}/api`, root]
    : [`${root}/testnet/api`, `${root}/testnet4/api`, `${root}/api`, root];
}

const layouts = new Map<string, ApiLayout>();
const layoutsPending = new Map<string, Promise<ApiLayout>>();
/**
 * A wallet refresh asks for dozens of addresses; one that found no API should
 * not probe the server again for each of them.
 */
const layoutFailures = new Map<string, { at: number; error: Error }>();
const LAYOUT_FAILURE_TTL_MS = 5_000;

const layoutKey = (root: string, network: NetworkName) => `${network} ${root}`;

/** Drops what has been learned about server layouts, so the next call looks again. */
export function forgetApiLayouts(): void {
  layouts.clear();
  layoutsPending.clear();
  layoutFailures.clear();
}

/**
 * Web root for a network, e.g. https://mempool.space/testnet. Null when the
 * server turned out to be a bare API with no website in front of it.
 */
export function esploraWebBase(network: NetworkName): string | null {
  const root = esploraServer();
  const layout = discoverLayout ? layouts.get(layoutKey(root, network)) : undefined;
  if (!layout) return network === 'mainnet' ? root : `${root}/testnet`;
  return layout.base.endsWith('/api') ? layout.base.slice(0, -'/api'.length) : null;
}

/** The chain the active server was found to serve for a network, once known. */
export function esploraGenesis(network: NetworkName): string | null {
  if (!discoverLayout) return null;
  return layouts.get(layoutKey(esploraServer(), network))?.genesis ?? null;
}

/** Give up on a stalled or unbounded response rather than hang forever. */
const FETCH_TIMEOUT_MS = 20_000;
/**
 * Address JSON from a well-behaved server is a few KB; anything past this is
 * a malformed or hostile response, so refuse it rather than parse it. (React
 * Native's fetch buffers the whole body, so the timeout above is the real
 * backstop against a deliberately endless stream — this catches the rest.)
 */
const MAX_RESPONSE_BYTES = 8_000_000;

/**
 * The scanner fans out one request per address. Public servers (mempool.space
 * in particular) answer a burst of those with 429, so cap how many are in
 * flight at once. A self-hosted node doesn't need this but doesn't mind it.
 */
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting: (() => void)[] = [];

/** Runs `task` once a slot is free. Slots are handed out in request order. */
export async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await task();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/** Retry budget for a throttled (429) or briefly unavailable (503) server. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/** Test hook — lets the retry path run without real waiting. */
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function setRetrySleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/**
 * How long to back off before retrying: the server's Retry-After if it gave
 * one (seconds or an HTTP date), else exponential from RETRY_BASE_MS.
 */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const secs = Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_MAX_MS);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_MAX_MS);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 503;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await httpFetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Something this module worked out about the server, already worded for the
 * person reading it — as opposed to whatever `fetch` threw.
 */
class ServerFinding extends Error {}

/** A GET that waits out throttling. A 429 that outlasts the retries is an error. */
async function getResponse(url: string): Promise<Response> {
  let res = await fetchWithTimeout(url);
  for (let attempt = 0; !res.ok && isRetryable(res.status) && attempt < MAX_ATTEMPTS - 1; attempt++) {
    await sleep(retryDelayMs(res.headers.get('retry-after'), attempt));
    res = await fetchWithTimeout(url);
  }
  if (res.status === 429) {
    throw new ServerFinding(
      `${esploraServer()} is rate limiting this wallet. Try again in a minute, or connect your own node or an Electrum server in Settings.`
    );
  }
  return res;
}

async function getText(url: string): Promise<string> {
  const res = await getResponse(url);
  if (!res.ok) throw new Error(`Network error (${res.status}) talking to the server`);
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('The server returned an unexpectedly large response.');
  }
  return text;
}

async function getJson<T>(url: string): Promise<T> {
  const text = await getText(url);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('The server returned a malformed response.');
  }
}

/** One short plain-text answer from a candidate API base; null if it is not there. */
async function probe(url: string): Promise<{ text: string } | { status: number }> {
  const res = await getResponse(url);
  if (!res.ok) return { status: res.status };
  const text = (await res.text()).trim();
  // A website answering for a path it does not have sends its front page.
  return text.length <= 100 ? { text } : { status: res.status };
}

/**
 * Finds where `root` serves the Esplora API for `network`, by asking each
 * candidate for block 0. That one answer shows both that the API is there
 * and which chain it is on, so a mainnet wallet is never pointed at a test
 * network or the reverse. Which test network is not checked: testnet3, 4 and
 * later share an address format, and the wallet works on any of them.
 */
export async function discoverApiLayout(root: string, network: NetworkName): Promise<ApiLayout> {
  const candidates = apiBaseCandidates(root, network);
  let otherNetwork = false;
  let lastStatus = 0;
  for (const base of candidates) {
    const answer = await probe(`${base}/block-height/0`);
    if ('status' in answer) {
      lastStatus = answer.status;
      continue;
    }
    const genesis = answer.text.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(genesis)) continue;
    if ((genesis === MAINNET_GENESIS) === (network === 'mainnet')) return { base, genesis };
    otherNetwork = true;
  }
  if (otherNetwork) {
    throw new ServerFinding(
      network === 'mainnet'
        ? `${root} serves a test network, not mainnet. It will work for testnet wallets; a mainnet wallet needs a mainnet server.`
        : `${root} only serves mainnet, and this is a testnet wallet. Connect a server that indexes testnet in Settings.`
    );
  }
  // A server that cannot look a block up by height may still be usable.
  for (const base of candidates) {
    const answer = await probe(`${base}/blocks/tip/height`);
    if ('text' in answer && /^\d{1,9}$/.test(answer.text)) return { base, genesis: null };
  }
  const found = lastStatus && lastStatus !== 200 ? ` (HTTP ${lastStatus})` : '';
  throw new ServerFinding(
    `No mempool or Esplora API found at ${root}${found}. Check the server address in Settings.`
  );
}

/** `discoverApiLayout`, remembered, and shared between calls made at once. */
function resolveApiLayout(root: string, network: NetworkName): Promise<ApiLayout> {
  const key = layoutKey(root, network);
  const known = layouts.get(key);
  if (known) return Promise.resolve(known);
  const failed = layoutFailures.get(key);
  if (failed && Date.now() - failed.at < LAYOUT_FAILURE_TTL_MS) return Promise.reject(failed.error);
  let pending = layoutsPending.get(key);
  if (!pending) {
    pending = discoverApiLayout(root, network).then(
      (layout) => {
        // Unless the server was switched or reset while this was in flight.
        if (layoutsPending.get(key) === pending) {
          layoutsPending.delete(key);
          layouts.set(key, layout);
        }
        return layout;
      },
      (error) => {
        if (layoutsPending.get(key) === pending) {
          layoutsPending.delete(key);
          layoutFailures.set(key, { at: Date.now(), error });
        }
        throw error;
      }
    );
    layoutsPending.set(key, pending);
  }
  return pending;
}

/** The URL every API call for `network` hangs off on the active server. */
async function apiBase(network: NetworkName): Promise<string> {
  const root = esploraServer();
  if (!discoverLayout) return conventionalApiBase(root, network);
  return (await resolveApiLayout(root, network)).base;
}

/**
 * Server-reported fee rates can be wrong or hostile, and an inflated one
 * would make the fee selector propose a wallet-draining fee. Clamp anything
 * outside a sane band; a bad or missing value falls back to a safe default.
 */
export const MAX_SANE_FEE_RATE = 2_000; // sat/vB — already absurdly high in practice

export function clampFeeRate(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, MAX_SANE_FEE_RATE);
}

function sanitizeFees(f: Partial<RecommendedFees> | null | undefined): RecommendedFees {
  const v = f ?? {};
  return {
    fastestFee: clampFeeRate(v.fastestFee as number, 10),
    halfHourFee: clampFeeRate(v.halfHourFee as number, 5),
    hourFee: clampFeeRate(v.hourFee as number, 3),
    economyFee: clampFeeRate(v.economyFee as number, 2),
    minimumFee: clampFeeRate(v.minimumFee as number, 1),
  };
}

export interface EsploraAddressStats {
  address: string;
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

export function fetchAddressStats(network: NetworkName, address: string) {
  return limited(async () => getJson<EsploraAddressStats>(`${await apiBase(network)}/address/${address}`));
}

export function fetchUtxos(network: NetworkName, address: string) {
  return limited(async () => getJson<EsploraUtxo[]>(`${await apiBase(network)}/address/${address}/utxo`));
}

export function fetchAddressTxs(network: NetworkName, address: string) {
  return limited(async () => getJson<EsploraTx[]>(`${await apiBase(network)}/address/${address}/txs`));
}

/**
 * A whole transaction as hex — what a hardware wallet needs for every coin
 * being spent, to check the amount it is told against the transaction that
 * created it. The caller verifies the hex hashes to `txid`; nothing the
 * server says here is taken on trust.
 */
export async function fetchTxHex(network: NetworkName, txid: string): Promise<string> {
  // Never interpolate an unvalidated txid into a URL.
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('That is not a transaction id.');
  const hex = (
    await limited(async () => getText(`${await apiBase(network)}/tx/${txid.toLowerCase()}/hex`))
  ).trim();
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('The server returned a malformed transaction.');
  return hex.toLowerCase();
}

export interface RecommendedFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

const FALLBACK_FEES: RecommendedFees = { fastestFee: 10, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 };

/**
 * Plain Esplora (blockstream.info, electrs) has no /v1/fees/recommended —
 * it serves /fee-estimates: sat/vB keyed by confirmation target in blocks.
 * Map that onto mempool.space's tiers. Esplora reports fractional rates
 * (0.3 sat/vB is common on a quiet chain); mempool.space rounds up to whole
 * sat/vB with a floor of 1, and the fee selector was built around that, so
 * do the same here.
 */
export function feesFromEstimates(estimates: Record<string, number> | null | undefined): RecommendedFees {
  const targets = Object.entries(estimates ?? {})
    .map(([k, v]) => [Number(k), Number(v)] as const)
    .filter(([k, v]) => Number.isFinite(k) && k > 0 && Number.isFinite(v) && v > 0)
    .sort((a, b) => a[0] - b[0]);
  if (targets.length === 0) return FALLBACK_FEES;
  // The rate for the first target at or beyond the one asked for; past the
  // end of the table, the slowest rate offered.
  const at = (blocks: number): number => {
    const hit = targets.find(([k]) => k >= blocks) ?? targets[targets.length - 1];
    return Math.max(1, Math.ceil(hit[1]));
  };
  return sanitizeFees({
    fastestFee: at(1),
    halfHourFee: at(3),
    hourFee: at(6),
    economyFee: at(144),
    minimumFee: at(1008),
  });
}

type FeeEndpoint = 'mempool' | 'esplora';
/** Which fee endpoint each server turned out to have, so we stop asking for the missing one. */
const feeEndpointByServer = new Map<string, FeeEndpoint>();

export async function fetchFees(network: NetworkName): Promise<RecommendedFees> {
  let base: string;
  try {
    base = await apiBase(network);
  } catch {
    return FALLBACK_FEES;
  }
  const known = feeEndpointByServer.get(base);
  if (known !== 'esplora') {
    try {
      const fees = sanitizeFees(
        await limited(() => getJson<RecommendedFees>(`${base}/v1/fees/recommended`))
      );
      feeEndpointByServer.set(base, 'mempool');
      return fees;
    } catch {
      // Fall through to the Esplora endpoint.
    }
  }
  try {
    const fees = feesFromEstimates(
      await limited(() => getJson<Record<string, number>>(`${base}/fee-estimates`))
    );
    feeEndpointByServer.set(base, 'esplora');
    return fees;
  } catch {
    return FALLBACK_FEES;
  }
}

/** Android refuses plain HTTP unless the build allows it. */
function describeFetchFailure(e: any, server: string): Error {
  const message = String(e?.message ?? e);
  if (/CLEARTEXT/i.test(message)) {
    return new Error('This build blocks plain HTTP. Rebuild the app to allow it (or use an https:// address).');
  }
  if (e?.name === 'AbortError') return new Error(`${server} did not answer in time.`);
  return new Error(`Could not reach ${server}: ${message}`);
}

/**
 * Checks that a server can serve wallets on `network`, and returns its block
 * height — used by Settings to test a URL. Always looks afresh.
 */
export async function fetchTipHeightFrom(server: string, network: NetworkName = 'mainnet'): Promise<number> {
  const root = server.trim().replace(/\/+$/, '');
  let layout: ApiLayout;
  let res: Response;
  try {
    layout = await discoverApiLayout(root, network);
    res = await getResponse(`${layout.base}/blocks/tip/height`);
  } catch (e: any) {
    throw e instanceof ServerFinding ? e : describeFetchFailure(e, root);
  }
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  const height = parseInt((await res.text()).trim(), 10);
  if (!Number.isFinite(height)) throw new Error('Server did not return a block height.');
  return height;
}

/**
 * Turns a node's rejection into something a person can act on.
 * The raw reason is kept on the end so nothing is hidden.
 */
export function describeBroadcastError(status: number, body: string): string {
  const reason = body.trim().replace(/\s+/g, ' ').slice(0, 300);
  // Node reasons mix hyphens, underscores and prose ("txn-already-in-mempool"
  // vs "Transaction already in block chain") — flatten separators to match both.
  const flat = reason.toLowerCase().replace(/[-_]+/g, ' ');

  if (/min relay fee not met|mempool min fee not met|min relay fee|fee.*too low|insufficient fee/.test(flat)) {
    return `The fee is too low for this node to accept — raise the fee rate and build the transaction again. (${reason})`;
  }
  // Check the confirmed case first — its wording also matches the mempool pattern.
  if (/already in (the )?(block ?chain|utxo)|txn already in chain/.test(flat)) {
    return 'This transaction has already confirmed. Refresh the wallet to see it.';
  }
  if (/already in (the )?mempool|txn already known|transaction already/.test(flat)) {
    return 'This transaction is already in the mempool — it has been sent. Refresh the wallet to see it.';
  }
  if (/missingorspent|missing inputs|bad txns inputs/.test(flat)) {
    return `One of the coins has already been spent — refresh the wallet and build the transaction again. (${reason})`;
  }
  if (/non mandatory script verify|script verify flag|signature/.test(flat)) {
    return `The node rejected the signatures. This usually means a cosigner signed a different version of the transaction. (${reason})`;
  }
  if (/dust/.test(flat)) {
    return `One of the outputs is below the dust limit. (${reason})`;
  }
  if (/too long mempool chain|too many ancestors/.test(flat)) {
    return 'Too many unconfirmed transactions ahead of this one — wait for one to confirm, then try again.';
  }
  if (status === 404) {
    return `The server has no broadcast endpoint at this address — check the server URL in Settings. (HTTP 404)`;
  }
  // A self-hosted mempool.space running against an Electrum server (Fulcrum,
  // electrs) can return a bare numeric code with no reason attached. The
  // transaction is often perfectly valid — the relay path is the problem.
  // (quotes may be backslash-escaped inside the JSON body, so match loosely)
  if (/sendrawtransaction rpc error/.test(flat) && /code/.test(flat) && !/message/.test(flat)) {
    return `Your server rejected this without giving a reason (${reason}). This usually points at the server's Electrum layer rather than the transaction itself — try broadcasting through another server below.`;
  }
  if (status >= 500) {
    return `The server had a problem (HTTP ${status}). Try again, or switch server in Settings. ${reason}`;
  }
  return `The node rejected this transaction (HTTP ${status}): ${reason || 'no reason given'}`;
}

export const PUBLIC_FALLBACK_SERVER = 'https://mempool.space';

/** Broadcast through a specific server — used for the fallback path. */
export async function broadcastTxVia(
  server: string,
  network: NetworkName,
  txHex: string
): Promise<string> {
  const root = server.replace(/\/+$/, '');
  const base = network === 'mainnet' ? `${root}/api` : `${root}/testnet/api`;
  let res: Response;
  try {
    res = await httpFetch(`${base}/tx`, { method: 'POST', body: txHex });
  } catch (e: any) {
    throw new Error(`Could not reach ${root}: ${String(e?.message ?? e)}`);
  }
  const body = await res.text();
  if (!res.ok) {
    console.error(`[broadcast:fallback] HTTP ${res.status} from ${root}: ${body}`);
    throw new Error(describeBroadcastError(res.status, body));
  }
  const txid = body.trim();
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error(`${root} accepted it but returned no txid: ${txid.slice(0, 200)}`);
  }
  return txid;
}

/** Broadcast a raw transaction. Returns the txid. */
export async function broadcastTx(network: NetworkName, txHex: string): Promise<string> {
  const base = await apiBase(network);
  let res: Response;
  try {
    res = await httpFetch(`${base}/tx`, { method: 'POST', body: txHex });
  } catch (e: any) {
    throw describeFetchFailure(e, esploraServer());
  }
  const body = await res.text();
  if (!res.ok) {
    // Never log the transaction itself — a signed tx in device logs is a
    // privacy leak and anyone reading them could broadcast it first.
    console.error(`[broadcast] HTTP ${res.status} from ${esploraServer()}: ${body.slice(0, 300)}`);
    throw new Error(describeBroadcastError(res.status, body));
  }
  const txid = body.trim();
  if (!/^[0-9a-f]{64}$/i.test(txid)) {
    console.error(`[broadcast] unexpected success body from ${esploraServer()}: ${body}`);
    throw new Error(`The server accepted the transaction but did not return a txid: ${txid.slice(0, 200)}`);
  }
  return txid;
}

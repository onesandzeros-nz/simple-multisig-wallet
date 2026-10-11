import { RelayPool, SocketFactory } from './client';
import { channelId, encryptPayload, generateSecretKey, NostrEvent, signEvent } from './crypto';
import { GROUP_EVENT_KIND } from './protocol';

export interface RelayProbe {
  url: string;
  /** The relay stored a test message and served it back to a fresh connection. */
  ok: boolean;
  /** Why not: the relay's own reason, or what went wrong. */
  reason?: string;
}

/**
 * Lands in the 32 KiB padding bucket: a transaction with a few dozen inputs.
 * The app allows far larger ones, and a relay that caps between here and
 * there would take the probe and refuse those — the outbox then reports its
 * refusal — but a relay that cannot take 32 KiB fails ordinary use, and a
 * probe at the full allowance would turn away relays that serve a group
 * perfectly well.
 */
const PROBE_BYTES = 30 * 1024;

/** Runs one step against a relay on its own connection, with a deadline. */
function step<T>(
  url: string,
  factory: SocketFactory | undefined,
  timeoutMs: number,
  onTimeout: T,
  run: (pool: RelayPool, finish: (result: T) => void) => void
): Promise<T> {
  return new Promise((resolve) => {
    const pool = new RelayPool([url], factory, { reconnectDelay: () => timeoutMs * 2 });
    let settled = false;
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pool.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(onTimeout), timeoutMs);
    run(pool, finish);
  });
}

/**
 * Asks a relay to store one throwaway group event of a realistic size, then
 * asks for it back on a fresh connection. A relay that refuses this kind,
 * caps events smaller than a transaction, wants authentication, forgets
 * what it accepted, or simply never answers is caught here, before a group
 * comes to depend on it.
 *
 * The event is encrypted under a random secret and signed by a random
 * identity, so it ties to nothing and says nothing.
 */
export async function probeRelay(url: string, factory?: SocketFactory, timeoutMs = 8000): Promise<RelayProbe> {
  const secret = generateSecretKey();
  const channel = channelId(secret);
  const event: NostrEvent = signEvent(generateSecretKey(), {
    created_at: Math.floor(Date.now() / 1000),
    kind: GROUP_EVENT_KIND,
    tags: [['t', channel]],
    content: encryptPayload(secret, JSON.stringify({ type: 'chat', name: 'probe', text: 'x'.repeat(PROBE_BYTES) })),
  });

  const stored = await step<{ ok: boolean; reason?: string }>(
    url,
    factory,
    timeoutMs,
    { ok: false, reason: 'no answer' },
    (pool, finish) => {
      pool.connect({
        onAck: (id, ack) => {
          if (id !== event.id) return;
          if (ack.ok || ack.reason.startsWith('duplicate:')) finish({ ok: true });
          else finish({ ok: false, reason: ack.reason || 'refused' });
        },
      });
      pool.publish(event);
    }
  );
  if (!stored.ok) return { url, ok: false, reason: stored.reason };

  // A client never sees its own publish on its own subscription, so the
  // read-back comes from a second connection — which is also the real
  // question: will the relay serve this to the other members?
  const served = await step<boolean>(url, factory, timeoutMs, false, (pool, finish) => {
    pool.connect({ onEvent: (e) => e.id === event.id && finish(true) });
    pool.subscribe({ kinds: [GROUP_EVENT_KIND], '#t': [channel], limit: 1 });
  });
  return served ? { url, ok: true } : { url, ok: false, reason: 'accepted it but did not serve it back' };
}

/** Probes every relay at once. */
export function probeRelays(urls: string[], factory?: SocketFactory, timeoutMs?: number): Promise<RelayProbe[]> {
  return Promise.all(urls.map((url) => probeRelay(url, factory, timeoutMs)));
}

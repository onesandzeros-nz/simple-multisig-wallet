import { bridgeError, bridgeRequestId, desktopBridge } from '../platform/bridge';

/**
 * HTTP for the block explorer APIs in the web bundle. Inside the desktop app
 * the request is made by the main process: a page has a same-origin policy
 * and a self-hosted mempool or Esplora rarely answers with CORS headers,
 * while a phone's fetch has no such rule. The answer comes back whole and is
 * wrapped in a Response so the callers do not know the difference. In a
 * plain browser it is the browser's fetch.
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const bridge = desktopBridge();
  if (!bridge) return fetch(url, init);

  const signal = init.signal ?? null;
  if (signal?.aborted) throw abortError();
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new Error('The desktop app can only send text request bodies.');
  }
  const id = bridgeRequestId();
  const onAbort = () => bridge.net.abort(id);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await bridge.net.fetch({
      id,
      url,
      method: init.method,
      headers: headerRecord(init.headers),
      body: init.body ?? undefined,
    });
    const status = res.status >= 200 && res.status <= 599 ? res.status : 500;
    return new Response(NULL_BODY_STATUSES.has(status) ? null : res.body, {
      status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw bridgeError(e);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

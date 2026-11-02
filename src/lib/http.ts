/**
 * HTTP for the block explorer APIs. On the phones this is the platform's
 * fetch; http.web.ts, which the web bundle gets instead, routes through the
 * desktop shell so a self-hosted server without CORS headers still works.
 * Looked up at call time so tests can stub `globalThis.fetch`.
 */
export function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

import React from 'react';
import { RelayPool } from './client';
import { GROUP_EVENT_KIND } from './protocol';

export type RelayState = 'connecting' | 'connected' | 'unreachable';

/**
 * Opens a throwaway connection to each relay purely to report whether it
 * answers. Nothing is published and no channel is subscribed to, so this
 * tells a relay nothing beyond "someone connected".
 */
export function useRelayStatus(
  relays: string[],
  enabled = true
): { status: Record<string, RelayState>; refresh: () => void } {
  const [status, setStatus] = React.useState<Record<string, RelayState>>({});
  // Bumped by refresh() to re-run the probe without the relay list changing.
  const [nonce, setNonce] = React.useState(0);
  const key = relays.join(',');

  React.useEffect(() => {
    if (!enabled || relays.length === 0) {
      setStatus({});
      return;
    }
    setStatus(Object.fromEntries(relays.map((r) => [r, 'connecting' as RelayState])));

    // One pool per relay so a single failure cannot mask the others.
    const pools = relays.map((url) => {
      const pool = new RelayPool([url]);
      pool.connect({
        onStatus: (connected) =>
          setStatus((current) => ({ ...current, [url]: connected > 0 ? 'connected' : 'unreachable' })),
      });
      // A relay that never answers stays "connecting" — call it unreachable.
      return { url, pool };
    });

    const timeout = setTimeout(() => {
      setStatus((current) => {
        const next = { ...current };
        for (const { url } of pools) if (next[url] === 'connecting') next[url] = 'unreachable';
        return next;
      });
    }, 8000);

    return () => {
      clearTimeout(timeout);
      for (const { pool } of pools) pool.close();
    };
  }, [key, enabled, nonce]);

  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  return { status, refresh };
}

export { GROUP_EVENT_KIND };

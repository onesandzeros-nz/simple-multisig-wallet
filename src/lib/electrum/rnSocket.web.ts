import { bridgeError, desktopBridge } from '../../platform/bridge';
import type { DesktopTcpEvent } from '../../platform/desktop';
import { ElectrumSocket, ElectrumSocketFactory, ElectrumTarget } from './client';

/**
 * The Electrum socket in the web bundle: a TCP connection the desktop shell
 * opens on the page's behalf (desktop/lib/tcp.js), with its events relayed
 * through the bridge. TLS connections are verified by Node — the chain and
 * the host name — which is more than react-native-tcp-socket does. A plain
 * browser has no TCP at all, so there the factory refuses.
 */
export function tcpAvailable(): boolean {
  return desktopBridge() !== null;
}

type Handler = (...args: any[]) => void;

export const rnSocketFactory: ElectrumSocketFactory = (target: ElectrumTarget): ElectrumSocket => {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error('Connecting to an Electrum server needs the desktop app; a browser cannot open TCP connections.');
  }
  const handlers: Record<string, Handler[]> = {};
  const emit = (event: string, ...args: any[]) => {
    for (const cb of handlers[event] ?? []) cb(...args);
  };
  let id: number | null = null;
  let destroyed = false;
  let unsubscribe: () => void = () => {};

  const onEvent = (ev: DesktopTcpEvent) => {
    if (destroyed) return;
    if (ev.type === 'connect') emit('connect');
    else if (ev.type === 'data') emit('data', ev.chunk);
    else if (ev.type === 'error') emit('error', new Error(ev.message));
    else if (ev.type === 'close') {
      unsubscribe();
      emit('close');
    }
  };

  bridge.tcp.connect({ host: target.host, port: target.port, tls: !!target.tls }).then(
    (opened) => {
      if (destroyed) {
        bridge.tcp.destroy(opened);
        return;
      }
      id = opened;
      unsubscribe = bridge.tcp.subscribe(opened, onEvent);
    },
    (e) => {
      // The client listens for these right after the factory returns, so by
      // the time this runs the handlers are in place.
      emit('error', bridgeError(e));
      emit('close');
    }
  );

  return {
    write(data: string) {
      if (id === null || destroyed) throw new Error('Not connected.');
      bridge.tcp.write(id, data).catch((e) => emit('error', bridgeError(e)));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      if (id !== null) bridge.tcp.destroy(id);
    },
    on(event: string, cb: Handler) {
      (handlers[event] ??= []).push(cb);
    },
  } as ElectrumSocket;
};

import { Buffer } from 'buffer';
import { ElectrumSocket, ElectrumSocketFactory, ElectrumTarget } from './client';

// Loaded defensively: the native module only exists in a development build,
// and the protocol layer must stay importable in plain Node for tests.
let TcpSocket: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TcpSocket = require('react-native-tcp-socket').default;
} catch {
  // no TCP support in this environment
}

export function tcpAvailable(): boolean {
  return !!TcpSocket;
}

/** Wraps react-native-tcp-socket in the small surface the client needs. */
export const rnSocketFactory: ElectrumSocketFactory = (target: ElectrumTarget): ElectrumSocket => {
  if (!TcpSocket) {
    throw new Error('Connecting to an Electrum server needs a development build with TCP support.');
  }
  const socket = target.tls
    ? // rejectUnauthorized keeps the certificate-chain check on. Note this
      // library does not verify the server *hostname* against the cert, so a
      // TLS Electrum connection should still only be trusted on a network you
      // control (LAN / VPN / Tor); the Settings screen warns about this.
      TcpSocket.connectTLS({ host: target.host, port: target.port, tls: true, rejectUnauthorized: true })
    : TcpSocket.createConnection({ host: target.host, port: target.port }, () => {});

  return {
    write: (data: string) => socket.write(data, 'utf8'),
    destroy: () => socket.destroy(),
    on: (event: string, cb: any) => {
      if (event === 'data') {
        socket.on('data', (chunk: any) =>
          cb(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        );
      } else {
        socket.on(event, cb);
      }
    },
  } as ElectrumSocket;
};

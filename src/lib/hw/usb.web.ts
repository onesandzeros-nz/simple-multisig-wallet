import { desktopBridge } from '../../platform/bridge';
import { FoundDevice, identifyDevice } from './devices';
import { PacketTransport } from './types';
import {
  describeHidDevice,
  describeUsbDevice,
  describeWebDeviceError,
  HidLike,
  openHidSession,
  openUsbSession,
  UsbLike,
  WebSession,
} from './webDevices';

/**
 * The computer's USB ports, as drivers see them, in the desktop app: the
 * same functions usb.ts gives the phone, over WebHID (Ledger, BitBox02,
 * Trezor Model One) and WebUSB (current Trezors). The desktop shell grants
 * the page these devices and no others (desktop/lib/hwDevices.js), so they
 * are listed as soon as they are plugged in, with no browser chooser.
 */

/** Where the device is plugged in, for the words around the device dialog. */
export const USB_HOST: string = 'this computer';

type Entry = { api: 'hid'; device: HidLike } | { api: 'usb'; device: UsbLike };

interface Nav {
  hid?: {
    getDevices(): Promise<HidLike[]>;
    addEventListener(type: 'connect' | 'disconnect', cb: (e: { device: HidLike }) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', cb: (e: { device: HidLike }) => void): void;
  };
  usb?: {
    getDevices(): Promise<UsbLike[]>;
    addEventListener(type: 'connect' | 'disconnect', cb: (e: { device: UsbLike }) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', cb: (e: { device: UsbLike }) => void): void;
  };
}

function nav(): Nav {
  return (typeof navigator === 'undefined' ? {} : navigator) as unknown as Nav;
}

// The device objects stay the same while a device is plugged in; each gets a
// name for the dialog to hand back.
const ids = new WeakMap<object, string>();
const entries = new Map<string, Entry>();
let counter = 0;
function idFor(device: object, api: 'hid' | 'usb'): string {
  let id = ids.get(device);
  if (!id) {
    counter += 1;
    id = `${api}-${counter}`;
    ids.set(device, id);
  }
  return id;
}

export function usbAvailable(): boolean {
  const n = nav();
  return desktopBridge() !== null && (!!n.hid || !!n.usb);
}

function platform(): string {
  return desktopBridge()?.platform ?? 'unknown';
}

/** The hardware wallets plugged in right now. */
export async function listHardwareWallets(): Promise<FoundDevice[]> {
  if (!usbAvailable()) return [];
  const n = nav();
  const [hid, usb] = await Promise.all([
    n.hid ? n.hid.getDevices().catch(() => [] as HidLike[]) : Promise.resolve([] as HidLike[]),
    n.usb ? n.usb.getDevices().catch(() => [] as UsbLike[]) : Promise.resolve([] as UsbLike[]),
  ]);
  entries.clear();
  const found: FoundDevice[] = [];
  for (const device of hid) {
    const id = idFor(device, 'hid');
    const described = describeHidDevice(id, device);
    const identified = described && identifyDevice(described);
    if (!identified) continue;
    entries.set(id, { api: 'hid', device });
    found.push(identified);
  }
  for (const device of usb) {
    const id = idFor(device, 'usb');
    const described = describeUsbDevice(id, device);
    const identified = described && identifyDevice(described);
    if (!identified) continue;
    entries.set(id, { api: 'usb', device });
    found.push(identified);
  }
  return found;
}

/** Calls back whenever something is plugged in or pulled out. Returns the way to stop. */
export function watchHardwareWallets(onChange: () => void): () => void {
  if (!usbAvailable()) return () => {};
  const n = nav();
  const cb = () => onChange();
  n.hid?.addEventListener('connect', cb);
  n.hid?.addEventListener('disconnect', cb);
  n.usb?.addEventListener('connect', cb);
  n.usb?.addEventListener('disconnect', cb);
  return () => {
    n.hid?.removeEventListener('connect', cb);
    n.hid?.removeEventListener('disconnect', cb);
    n.usb?.removeEventListener('connect', cb);
    n.usb?.removeEventListener('disconnect', cb);
  };
}

// Sessions open now, so an unplugged device fails the driver waiting on it.
const sessions = new Map<object, WebSession>();
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  const gone = (e: { device: object }) => {
    sessions.get(e.device)?.fail(new Error('The device was unplugged.'));
    sessions.delete(e.device);
  };
  nav().hid?.addEventListener('disconnect', gone as (e: { device: HidLike }) => void);
  nav().usb?.addEventListener('disconnect', gone as (e: { device: UsbLike }) => void);
}

/** Opens the interface that carries the wallet protocol. */
export async function openHardwareWallet(found: FoundDevice): Promise<PacketTransport> {
  if (!usbAvailable()) throw new Error('This computer cannot connect to USB devices from the app.');
  const entry = entries.get(found.id);
  if (!entry) throw new Error(`The ${found.model} is no longer plugged in.`);
  listen();
  const describe = (e: unknown) => describeWebDeviceError(e, found.model, platform());
  let session: WebSession;
  if (entry.api === 'hid') {
    session = await openHidSession(entry.device, describe);
  } else {
    const iface = describeUsbDevice(found.id, entry.device)?.interfaces[found.interfaceIndex];
    if (!iface) throw new Error(`The ${found.model} no longer has the interface it had.`);
    session = await openUsbSession(entry.device, iface.number, describe);
  }
  sessions.set(entry.device, session);
  const { transport } = session;
  return {
    packetSize: transport.packetSize,
    write: (packet) => transport.write(packet),
    read: (timeoutMs) => transport.read(timeoutMs),
    async close() {
      if (sessions.get(entry.device) === session) sessions.delete(entry.device);
      await transport.close();
    },
  };
}

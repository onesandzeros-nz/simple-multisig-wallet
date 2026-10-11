import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import UsbHost from '../../../modules/usb-host';
import { FoundDevice, identifyDevices } from './devices';
import { PacketQueue } from './packetQueue';
import { PacketTransport, UserCancelled } from './types';
import { describeUsbError } from './usbErrors';

/**
 * The phone's USB port, as drivers see it. Android only: iOS gives apps no
 * access to USB devices, so there the module is absent and nothing here is
 * offered.
 */

export function usbAvailable(): boolean {
  try {
    return Platform.OS === 'android' && !!UsbHost && UsbHost.isSupported === true;
  } catch {
    return false;
  }
}

/** The hardware wallets plugged in right now. */
export function listHardwareWallets(): FoundDevice[] {
  if (!usbAvailable()) return [];
  try {
    return identifyDevices(UsbHost!.listDevices());
  } catch (e: any) {
    console.warn(`[usb] could not list devices: ${e?.message ?? e}`);
    return [];
  }
}

/** Calls back whenever something is plugged in or pulled out. Returns the way to stop. */
export function watchHardwareWallets(onChange: () => void): () => void {
  if (!usbAvailable()) return () => {};
  const subscription = UsbHost!.addListener('onDevicesChanged', () => onChange());
  return () => subscription.remove();
}

// One pair of listeners serves every session. A packet can reach JavaScript
// before the `open` call that started its session has resolved, so packets
// for a handle nobody has claimed yet are held rather than dropped.
const queues = new Map<number, PacketQueue>();
const unclaimed = new Map<number, Uint8Array[]>();
let listening = false;

function listen(): void {
  if (listening || !UsbHost) return;
  listening = true;
  UsbHost.addListener('onPacket', ({ handle, data }) => {
    const packet = Uint8Array.from(Buffer.from(data, 'hex'));
    const queue = queues.get(handle);
    if (queue) {
      queue.push(packet);
      return;
    }
    const held = unclaimed.get(handle) ?? [];
    held.push(packet);
    unclaimed.set(handle, held);
  });
  UsbHost.addListener('onClosed', ({ handle }) => {
    unclaimed.delete(handle);
    queues.get(handle)?.fail(new Error('The device was unplugged.'));
    queues.delete(handle);
  });
}

/**
 * Asks Android for the device (its own dialog, the first time) and opens the
 * interface that carries the wallet protocol.
 */
export async function openHardwareWallet(found: FoundDevice): Promise<PacketTransport> {
  if (!usbAvailable()) throw new Error('This phone cannot connect to USB devices.');
  listen();

  const allowed = await UsbHost!.requestPermission(found.id).catch((e) => {
    throw describeUsbError(e);
  });
  if (!allowed) {
    throw new UserCancelled(`Android was not given permission to use the ${found.model}.`);
  }
  const { handle, packetSize } = await UsbHost!.open(found.id, found.interfaceIndex).catch((e) => {
    throw describeUsbError(e);
  });

  const queue = new PacketQueue();
  for (const packet of unclaimed.get(handle) ?? []) queue.push(packet);
  unclaimed.delete(handle);
  queues.set(handle, queue);

  let closed = false;
  return {
    packetSize,
    async write(packet: Uint8Array): Promise<void> {
      if (closed) throw new Error('The connection to the device is closed.');
      if (packet.length > packetSize) throw new Error('Packet too large for the device.');
      // These devices take whole packets only; a short one is padded out.
      const padded = new Uint8Array(packetSize);
      padded.set(packet);
      await UsbHost!.write(handle, padded).catch((e) => {
        throw describeUsbError(e);
      });
    },
    read(timeoutMs: number): Promise<Uint8Array> {
      return queue.read(timeoutMs);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Whatever is waiting on the device stops waiting now, not when the
      // phone gets round to reporting the session closed.
      queue.fail(new UserCancelled('Disconnected.'));
      queues.delete(handle);
      await UsbHost!.close(handle).catch(() => {});
    },
  };
}

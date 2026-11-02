import type { UsbDeviceDescription } from '../../../modules/usb-host/src/UsbHost.types';
import { PacketQueue } from './packetQueue';
import { PacketTransport, UserCancelled } from './types';

/**
 * Hardware wallets through the browser's device APIs, which the desktop app
 * (Chromium inside Electron) has where the phone has its USB host module:
 * WebHID for the Ledger, the BitBox02 and the old Trezor Model One, WebUSB
 * for current Trezors, whose wallet interface is vendor-specific USB.
 *
 * Each device is described in the same shape the phone's module reports, so
 * `identifyDevice` (devices.ts) decides what it is in one place, and opened
 * as the same 64-byte packet transport the drivers already speak through.
 * Kept free of React Native imports and written against the small slice of
 * the WebHID/WebUSB interfaces it uses, so it can be unit tested in Node.
 */

// ---- the slices of WebHID and WebUSB used here --------------------------------

export interface HidLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: ReadonlyArray<{ usagePage?: number; usage?: number }>;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: { data: DataView }) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: { data: DataView }) => void): void;
}

interface UsbEndpointLike {
  readonly endpointNumber: number;
  readonly direction: 'in' | 'out';
  readonly type: 'bulk' | 'interrupt' | 'isochronous';
  readonly packetSize: number;
}

interface UsbInterfaceLike {
  readonly interfaceNumber: number;
  readonly alternate: {
    readonly interfaceClass: number;
    readonly interfaceSubclass: number;
    readonly interfaceProtocol: number;
    readonly endpoints: ReadonlyArray<UsbEndpointLike>;
  } | null;
}

interface UsbConfigurationLike {
  readonly configurationValue: number;
  readonly interfaces: ReadonlyArray<UsbInterfaceLike>;
}

export interface UsbLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly manufacturerName?: string;
  readonly configuration: UsbConfigurationLike | null;
  readonly configurations: ReadonlyArray<UsbConfigurationLike>;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  releaseInterface(number: number): Promise<void>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<{ status?: string; data?: DataView }>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<{ status?: string }>;
}

// ---- which devices, over which API ------------------------------------------------

const LEDGER = 0x2c97;
const TREZOR = 0x1209;
const TREZOR_ONE = 0x534c;
const BITBOX = 0x03eb;

/**
 * What to look for over WebHID: Ledgers, the BitBox02, and a Trezor Model One
 * from before firmware 1.7. Current Trezors are WebUSB only.
 */
export const HID_FILTERS = [
  { vendorId: LEDGER },
  { vendorId: BITBOX, productId: 0x2403 },
  { vendorId: TREZOR_ONE, productId: 0x0001 },
];

/** What to look for over WebUSB: current Trezors (Model T, Safe, and a Model One on 1.7 or later), and their bootloader. */
export const USB_FILTERS = [
  { vendorId: TREZOR, productId: 0x53c1 },
  { vendorId: TREZOR, productId: 0x53c0 },
];

function matches(filters: ReadonlyArray<{ vendorId: number; productId?: number }>, d: { vendorId: number; productId: number }) {
  return filters.some((f) => f.vendorId === d.vendorId && (f.productId === undefined || f.productId === d.productId));
}

export function isHidWallet(d: { vendorId: number; productId: number }): boolean {
  return matches(HID_FILTERS, d);
}

export function isUsbWallet(d: { vendorId: number; productId: number }): boolean {
  return matches(USB_FILTERS, d);
}

/**
 * The wallet protocol runs over a vendor-defined HID collection (usage page
 * 0xFF00 to 0xFFFF: 0xFFA0 on a Ledger, 0xFFFF on a BitBox02). The FIDO
 * interface these devices also have (0xF1D0) is something else, and Chromium
 * does not hand it out anyway.
 */
function hasWalletCollection(device: HidLike): boolean {
  return device.collections.some((c) => (c.usagePage ?? 0) >= 0xff00);
}

/**
 * A WebHID device in the phone module's shape: one HID interface with an
 * interrupt endpoint each way, which is what a HID device is to the drivers.
 * Null for a HID device that is not a wallet's protocol interface.
 */
export function describeHidDevice(id: string, device: HidLike): UsbDeviceDescription | null {
  if (!isHidWallet(device) || !hasWalletCollection(device)) return null;
  return {
    id,
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName || null,
    manufacturerName: null,
    hasPermission: true,
    interfaces: [
      {
        index: 0,
        number: 0,
        class: 0x03,
        subclass: 0,
        protocol: 0,
        endpoints: [
          { address: 0x81, direction: 'in', type: 'interrupt', maxPacketSize: 64 },
          { address: 0x01, direction: 'out', type: 'interrupt', maxPacketSize: 64 },
        ],
      },
    ],
  };
}

function usbConfiguration(device: UsbLike): UsbConfigurationLike | null {
  return device.configuration ?? device.configurations[0] ?? null;
}

/** A WebUSB device in the phone module's shape, interfaces and endpoints as the descriptor has them. */
export function describeUsbDevice(id: string, device: UsbLike): UsbDeviceDescription | null {
  if (!isUsbWallet(device)) return null;
  const config = usbConfiguration(device);
  if (!config) return null;
  return {
    id,
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName || null,
    manufacturerName: device.manufacturerName || null,
    hasPermission: true,
    interfaces: config.interfaces
      .filter((i) => i.alternate)
      .map((i, index) => ({
        index,
        number: i.interfaceNumber,
        class: i.alternate!.interfaceClass,
        subclass: i.alternate!.interfaceSubclass,
        protocol: i.alternate!.interfaceProtocol,
        endpoints: i.alternate!.endpoints
          .filter((e) => e.type !== 'isochronous')
          .map((e) => ({
            address: e.endpointNumber | (e.direction === 'in' ? 0x80 : 0),
            direction: e.direction,
            type: e.type,
            maxPacketSize: e.packetSize,
          })),
      })),
  };
}

// ---- errors worth explaining -------------------------------------------------------

/**
 * What the device APIs throw, in words for the person at the computer. The
 * two that need explaining are access (on Linux a device belongs to root
 * until a udev rule says otherwise) and another program holding the device.
 */
export function describeWebDeviceError(e: unknown, model: string, platform: string): Error {
  const name = (e as { name?: string })?.name ?? '';
  const message = String((e as { message?: string })?.message ?? e ?? '').trim();
  if (/access denied|permission|not allowed/i.test(message) || name === 'SecurityError' || name === 'NotAllowedError') {
    return new Error(
      platform === 'linux'
        ? `This computer would not let the app open the ${model}. Linux needs a udev rule for hardware wallets; the .deb package installs one, otherwise see "Hardware wallets on Linux" in the README. Then unplug the device and plug it back in.`
        : `This computer would not let the app open the ${model}.`
    );
  }
  if (/claim|busy|in use|failed to open/i.test(message) || name === 'NetworkError' || name === 'InvalidStateError') {
    return new Error(
      `The ${model} is in use by another program. Close Ledger Live, Trezor Suite or Trezor Bridge, the BitBox app, or any other wallet that is connected to it, then try again.`
    );
  }
  return new Error(message || `The connection to the ${model} failed.`);
}

// ---- packet transports ------------------------------------------------------------

const PACKET_SIZE = 64;

function copyOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function padded(packet: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (packet.length > size) throw new Error('Packet too large for the device.');
  // These devices take whole packets only; a short one is padded out.
  const out = new Uint8Array(new ArrayBuffer(size));
  out.set(packet);
  return out;
}

/** A session on one device. `fail` is how the caller reports the device unplugged. */
export interface WebSession {
  transport: PacketTransport;
  fail(error: Error): void;
}

/**
 * A WebHID device as a packet transport. Reports go out with report id 0
 * (these devices use none) and come in as `inputreport` events.
 */
export async function openHidSession(device: HidLike, describe: (e: unknown) => Error): Promise<WebSession> {
  if (!device.opened) await device.open().catch((e) => Promise.reject(describe(e)));
  const queue = new PacketQueue();
  const onReport = (event: { data: DataView }) => queue.push(copyOf(event.data));
  device.addEventListener('inputreport', onReport);
  let closed = false;
  return {
    fail: (error) => queue.fail(error),
    transport: {
      packetSize: PACKET_SIZE,
      async write(packet) {
        if (closed) throw new Error('The connection to the device is closed.');
        await device.sendReport(0, padded(packet, PACKET_SIZE)).catch((e) => Promise.reject(describe(e)));
      },
      read: (timeoutMs) => queue.read(timeoutMs),
      async close() {
        if (closed) return;
        closed = true;
        queue.fail(new UserCancelled('Disconnected.'));
        device.removeEventListener('inputreport', onReport);
        await device.close().catch(() => {});
      },
    },
  };
}

/**
 * A WebUSB device as a packet transport: the interface claimed, and a read
 * kept waiting on its IN endpoint for as long as the session lasts, feeding
 * the same queue the phone's events do.
 */
export async function openUsbSession(
  device: UsbLike,
  interfaceNumber: number,
  describe: (e: unknown) => Error
): Promise<WebSession> {
  try {
    if (!device.opened) await device.open();
    if (!device.configuration) {
      const first = device.configurations[0];
      if (!first) throw new Error('The device reports no USB configuration.');
      await device.selectConfiguration(first.configurationValue);
    }
    await device.claimInterface(interfaceNumber);
  } catch (e) {
    await device.close().catch(() => {});
    throw describe(e);
  }
  const iface = device.configuration?.interfaces.find((i) => i.interfaceNumber === interfaceNumber);
  const usable = (iface?.alternate?.endpoints ?? []).filter((e) => e.type === 'interrupt' || e.type === 'bulk');
  const inEp = usable.find((e) => e.direction === 'in');
  const outEp = usable.find((e) => e.direction === 'out');
  if (!inEp || !outEp) {
    await device.releaseInterface(interfaceNumber).catch(() => {});
    await device.close().catch(() => {});
    throw new Error('The device has no way to send and receive packets on that interface.');
  }
  const packetSize = outEp.packetSize || PACKET_SIZE;
  const queue = new PacketQueue();
  let closed = false;

  const pump = async () => {
    while (!closed) {
      try {
        const result = await device.transferIn(inEp.endpointNumber, inEp.packetSize || PACKET_SIZE);
        if (closed) return;
        if (result.status === 'stall') {
          await device.clearHalt('in', inEp.endpointNumber);
          continue;
        }
        if (result.data && result.data.byteLength > 0) queue.push(copyOf(result.data));
      } catch (e) {
        if (!closed) queue.fail(describe(e));
        return;
      }
    }
  };
  void pump();

  return {
    fail: (error) => queue.fail(error),
    transport: {
      packetSize,
      async write(packet) {
        if (closed) throw new Error('The connection to the device is closed.');
        const result = await device
          .transferOut(outEp.endpointNumber, padded(packet, packetSize))
          .catch((e) => Promise.reject(describe(e)));
        if (result.status && result.status !== 'ok') throw new Error(`The device refused the packet (${result.status}).`);
      },
      read: (timeoutMs) => queue.read(timeoutMs),
      async close() {
        if (closed) return;
        closed = true;
        queue.fail(new UserCancelled('Disconnected.'));
        await device.releaseInterface(interfaceNumber).catch(() => {});
        await device.close().catch(() => {});
      },
    },
  };
}

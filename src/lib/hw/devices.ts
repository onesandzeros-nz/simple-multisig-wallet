import type { UsbDeviceDescription, UsbInterfaceDescription } from '../../../modules/usb-host/src/UsbHost.types';
import { HardwareKind } from './types';

/**
 * Which of the things plugged into the phone is a hardware wallet this app can
 * talk to, and which of its USB interfaces carries the wallet protocol. Kept
 * free of React Native imports so it can be unit tested in Node.
 */

export interface FoundDevice {
  /** The phone's handle on it; changes every time the device is plugged in. */
  id: string;
  kind: HardwareKind;
  /** What to call it on screen before the device has said anything itself. */
  model: string;
  /** Which entry of the device's interface list to open. */
  interfaceIndex: number;
  productId: number;
  /**
   * The device is showing its bootloader, not its wallet — it is listed so
   * the user can be told why it will not connect, rather than seeing nothing.
   */
  bootloader: boolean;
  hasPermission: boolean;
}

const USB_CLASS_HID = 0x03;
const USB_CLASS_VENDOR = 0xff;

const LEDGER_VENDOR = 0x2c97;
const TREZOR_VENDOR = 0x1209;
const TREZOR_ONE_VENDOR = 0x534c;
const BITBOX_VENDOR = 0x03eb;

/**
 * Ledger product ids carry the model in the high byte; the low byte is a set
 * of flags for the interfaces the running app exposes, so it changes as apps
 * are opened and closed. Devices from before that scheme used a bare number.
 */
const LEDGER_MODELS: Record<number, string> = {
  0x10: 'Ledger Nano S',
  0x40: 'Ledger Nano X',
  0x50: 'Ledger Nano S Plus',
  0x60: 'Ledger Stax',
  0x70: 'Ledger Flex',
  0x80: 'Ledger Nano Gen5',
};
const LEDGER_LEGACY_MODELS: Record<number, string> = {
  0x0001: 'Ledger Nano S',
  0x0004: 'Ledger Nano X',
  0x0005: 'Ledger Nano S Plus',
  0x0006: 'Ledger Stax',
  0x0007: 'Ledger Flex',
};

/** What the descriptor alone gives away; the rest is the phone's. */
type Identified = Omit<FoundDevice, 'id' | 'productId' | 'hasPermission'>;

/** True when the interface has somewhere to write packets and somewhere to read them. */
function carriesPackets(i: UsbInterfaceDescription): boolean {
  const usable = i.endpoints.filter((e) => e.type === 'interrupt' || e.type === 'bulk');
  return usable.some((e) => e.direction === 'in') && usable.some((e) => e.direction === 'out');
}

function firstInterface(device: UsbDeviceDescription, usbClass: number): number | null {
  const hit = device.interfaces.find((i) => i.class === usbClass && carriesPackets(i));
  return hit ? hit.index : null;
}

function identifyLedger(device: UsbDeviceDescription): Identified | null {
  // The wallet protocol runs over the generic HID interface, which comes
  // first; a FIDO interface, when the running app has one, follows it.
  const interfaceIndex = firstInterface(device, USB_CLASS_HID);
  if (interfaceIndex === null) return null;
  const model =
    LEDGER_MODELS[device.productId >> 8] ?? LEDGER_LEGACY_MODELS[device.productId] ?? 'Ledger';
  return { kind: 'ledger', model, interfaceIndex, bootloader: false };
}

function identifyTrezor(device: UsbDeviceDescription): Identified | null {
  const one = device.vendorId === TREZOR_ONE_VENDOR;
  if (one && device.productId !== 0x0001) return null;
  if (!one && device.productId !== 0x53c1 && device.productId !== 0x53c0) return null;
  // Current firmware speaks over a vendor-specific interface (WebUSB); a
  // Model One from before 1.7.0 only has HID. The vendor interface is
  // preferred because a device can have both, the HID one being for FIDO.
  const interfaceIndex = firstInterface(device, USB_CLASS_VENDOR) ?? firstInterface(device, USB_CLASS_HID);
  if (interfaceIndex === null) return null;
  return {
    kind: 'trezor',
    model: one ? 'Trezor Model One' : 'Trezor',
    interfaceIndex,
    bootloader: !one && device.productId === 0x53c0,
  };
}

function identifyBitBox(device: UsbDeviceDescription): Identified | null {
  if (device.productId !== 0x2403) return null;
  // The vendor id belongs to the chip maker and is shared with unrelated
  // devices, so the product name has to agree too.
  const name = (device.productName ?? '').toLowerCase();
  if (!/^(bitbox02|bb02)/.test(name)) return null;
  // Interface 0 is the wallet; the second HID interface is FIDO/U2F.
  const interfaceIndex = firstInterface(device, USB_CLASS_HID);
  if (interfaceIndex === null) return null;
  return {
    kind: 'bitbox02',
    model: name.includes('nova') ? 'BitBox02 Nova' : 'BitBox02',
    interfaceIndex,
    // "bb02-bootloader", "bb02btc-bootloader", and on a Nova "… Multi bl".
    bootloader: name.includes('bootloader') || /\sbl$/.test(name),
  };
}

/** The hardware wallet behind a USB descriptor, or null when it is something else. */
export function identifyDevice(device: UsbDeviceDescription): FoundDevice | null {
  let found: Identified | null = null;
  if (device.vendorId === LEDGER_VENDOR) found = identifyLedger(device);
  else if (device.vendorId === TREZOR_VENDOR || device.vendorId === TREZOR_ONE_VENDOR) found = identifyTrezor(device);
  else if (device.vendorId === BITBOX_VENDOR) found = identifyBitBox(device);
  return found
    ? { ...found, id: device.id, productId: device.productId, hasPermission: device.hasPermission }
    : null;
}

export function identifyDevices(devices: UsbDeviceDescription[]): FoundDevice[] {
  return devices.map(identifyDevice).filter((d): d is FoundDevice => d !== null);
}

const KIND_NAMES: Record<HardwareKind, string> = {
  ledger: 'Ledger',
  trezor: 'Trezor',
  bitbox02: 'BitBox02',
};

export function kindName(kind: HardwareKind): string {
  return KIND_NAMES[kind];
}

export function isHardwareKind(source: string | undefined): source is HardwareKind {
  return source === 'ledger' || source === 'trezor' || source === 'bitbox02';
}

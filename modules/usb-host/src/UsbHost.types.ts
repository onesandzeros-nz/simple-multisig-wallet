export interface UsbEndpointDescription {
  address: number;
  direction: 'in' | 'out';
  type: 'interrupt' | 'bulk' | 'isochronous' | 'control';
  maxPacketSize: number;
}

export interface UsbInterfaceDescription {
  /** Position in the device's interface list — what `open` takes. */
  index: number;
  /** bInterfaceNumber from the descriptor. */
  number: number;
  class: number;
  subclass: number;
  protocol: number;
  endpoints: UsbEndpointDescription[];
}

export interface UsbDeviceDescription {
  /** Android's name for the device, e.g. /dev/bus/usb/001/002. It changes each time the device is plugged in. */
  id: string;
  vendorId: number;
  productId: number;
  productName: string | null;
  manufacturerName: string | null;
  hasPermission: boolean;
  interfaces: UsbInterfaceDescription[];
}

export interface UsbSession {
  handle: number;
  packetSize: number;
}

export type UsbHostModuleEvents = {
  /** One packet from the device; `data` is hex. */
  onPacket: (event: { handle: number; data: string }) => void;
  /** The session ended: closed from here, or the device was unplugged. */
  onClosed: (event: { handle: number }) => void;
  /** Something was plugged in or pulled out — list the devices again. */
  onDevicesChanged: (event: { attached: boolean }) => void;
};

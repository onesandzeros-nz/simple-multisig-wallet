import { BitBox02Device } from './bitbox02';
import { LedgerDevice } from './ledger';
import { TrezorDevice } from './trezor';
import { DriverOptions, HardwareDevice, HardwareKind, PacketTransport } from './types';

export * from './types';
export { readKeyFromDevice, signPsbtWithDevice } from './sign';
export type { DeviceSigningResult, FetchTx } from './sign';
export { identifyDevice, identifyDevices, isHardwareKind, kindName } from './devices';
export type { FoundDevice } from './devices';

/** The driver that speaks to a device of this kind over `transport`. */
export function createDriver(
  kind: HardwareKind,
  transport: PacketTransport,
  options: DriverOptions,
  /** What USB said about the device. A Ledger's model is only to be had from its product id. */
  usb: { productId?: number } = {}
): HardwareDevice {
  switch (kind) {
    case 'ledger':
      return new LedgerDevice(transport, options, usb);
    case 'trezor':
      return new TrezorDevice(transport, options);
    case 'bitbox02':
      return new BitBox02Device(transport, options);
  }
}

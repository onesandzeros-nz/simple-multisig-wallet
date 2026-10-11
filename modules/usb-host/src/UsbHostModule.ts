import { NativeModule, requireOptionalNativeModule } from 'expo';

import { UsbDeviceDescription, UsbHostModuleEvents, UsbSession } from './UsbHost.types';

declare class UsbHostModule extends NativeModule<UsbHostModuleEvents> {
  /** Whether this phone can act as a USB host at all. */
  isSupported: boolean;
  listDevices(): UsbDeviceDescription[];
  /** Shows Android's permission dialog if needed. Resolves with whether access is allowed. */
  requestPermission(deviceId: string): Promise<boolean>;
  /** Claims one interface and starts delivering its packets as `onPacket` events. */
  open(deviceId: string, interfaceIndex: number): Promise<UsbSession>;
  write(handle: number, packet: Uint8Array): Promise<void>;
  close(handle: number): Promise<void>;
}

// Android only, and only in a build that includes the module — null on iOS
// and in Expo Go, where the USB buttons are simply not offered.
export default requireOptionalNativeModule<UsbHostModule>('UsbHost');

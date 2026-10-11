/**
 * BitBox02 and BitBox02 Nova (Multi and Bitcoin-only editions) over USB.
 *
 * The device is recognised on the bus by vendor id 0x03eb and product id
 * 0x2403, and spoken to on interface 0 — a HID interface with one interrupt
 * endpoint each way (IN 0x81, OUT 0x02), 64 bytes a packet. Interface 1, on
 * the Multi edition only, is its U2F security-key function and is left alone.
 */
export { BitBox02Device, BitBox02Error, BITBOX02_MEMORY_KEYS, READ_TIMEOUT_MS } from './device';
export type { BitBox02Options } from './device';

export const BITBOX02_USB = {
  vendorId: 0x03eb,
  /** 0x2402 was used by some pre-production bootloaders only. */
  productIds: [0x2403],
  interface: 0,
  endpointIn: 0x81,
  endpointOut: 0x02,
  packetSize: 64,
} as const;

/**
 * The USB product string says what is running before anything is sent: the
 * wallet firmware, or the bootloader that only installs firmware.
 */
export const BITBOX02_PRODUCT_STRINGS: Record<string, { model: string; bootloader: boolean }> = {
  BitBox02: { model: 'BitBox02 Multi', bootloader: false },
  BitBox02BTC: { model: 'BitBox02 Bitcoin-only', bootloader: false },
  'BitBox02 Nova Multi': { model: 'BitBox02 Nova Multi', bootloader: false },
  'BitBox02 Nova BTC-only': { model: 'BitBox02 Nova Bitcoin-only', bootloader: false },
  'bb02-bootloader': { model: 'BitBox02 Multi', bootloader: true },
  'bb02btc-bootloader': { model: 'BitBox02 Bitcoin-only', bootloader: true },
  'BitBox02 Nova Multi bl': { model: 'BitBox02 Nova Multi', bootloader: true },
  'BitBox02 Nova BTC-only bl': { model: 'BitBox02 Nova Bitcoin-only', bootloader: true },
};

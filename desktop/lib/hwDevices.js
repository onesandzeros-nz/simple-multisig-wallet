'use strict';

/**
 * The USB devices the page may use: hardware wallets the app has a driver
 * for, and nothing else. A vendor id alone is not enough where the id is
 * shared (pid.codes for Trezor, Microchip for the BitBox02), so the product
 * id is checked there too. Mirrors src/lib/hw/webDevices.ts.
 */
const WALLETS = [
  { vendorId: 0x2c97 }, // Ledger, every model
  { vendorId: 0x1209, productId: 0x53c1 }, // Trezor
  { vendorId: 0x1209, productId: 0x53c0 }, // Trezor bootloader (listed so the app can say so)
  { vendorId: 0x534c, productId: 0x0001 }, // Trezor Model One before firmware 1.7
  { vendorId: 0x03eb, productId: 0x2403 }, // BitBox02
];

function isWalletDevice(device) {
  if (!device || typeof device !== 'object') return false;
  const { vendorId, productId } = device;
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return false;
  return WALLETS.some((w) => w.vendorId === vendorId && (w.productId === undefined || w.productId === productId));
}

module.exports = { WALLETS, isWalletDevice };

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { identifyDevice } from '../src/lib/hw/devices';
import { TransportTimeout, UserCancelled } from '../src/lib/hw/types';
import {
  describeHidDevice,
  describeUsbDevice,
  describeWebDeviceError,
  HidLike,
  isHidWallet,
  isUsbWallet,
  openHidSession,
  openUsbSession,
  UsbLike,
} from '../src/lib/hw/webDevices';

/**
 * Hardware wallets over WebHID and WebUSB on the desktop: what the browser
 * reports for a Ledger, a Trezor and a BitBox02 is identified the same way
 * the phone's USB descriptors are, and opens as the same packet transport.
 * The devices are stand-ins shaped like Chromium's HIDDevice and USBDevice.
 */
const require = createRequire(import.meta.url);
const { isWalletDevice } = require('../desktop/lib/hwDevices.js');

function fakeHid(overrides: Partial<HidLike> & { vendorId: number; productId: number }) {
  const listeners = new Set<(e: { data: DataView }) => void>();
  const sent: { reportId: number; data: Uint8Array }[] = [];
  const device = {
    productName: 'Nano S Plus',
    collections: [{ usagePage: 0xffa0, usage: 0x01 }],
    opened: false,
    async open() {
      device.opened = true;
    },
    async close() {
      device.opened = false;
    },
    async sendReport(reportId: number, data: BufferSource) {
      sent.push({ reportId, data: new Uint8Array(data as ArrayBuffer) });
    },
    addEventListener: (_t: 'inputreport', l: (e: { data: DataView }) => void) => void listeners.add(l),
    removeEventListener: (_t: 'inputreport', l: (e: { data: DataView }) => void) => void listeners.delete(l),
    ...overrides,
  };
  const report = (bytes: number[]) => {
    // Chromium hands over a view that may sit inside a larger buffer.
    const buf = new Uint8Array([0xee, ...bytes, 0xee]).buffer;
    for (const l of listeners) l({ data: new DataView(buf, 1, bytes.length) });
  };
  return { device: device as HidLike & { opened: boolean }, sent, report, listeners };
}

/** A Trezor as Chromium's WebUSB reports it: one vendor-class interface, interrupt endpoint 1 each way. */
function fakeTrezor(opts: { claimError?: Error; openError?: Error } = {}) {
  const incoming: Uint8Array[] = [];
  const waiting: Array<(r: { status: string; data: DataView }) => void> = [];
  const sent: Uint8Array[] = [];
  const calls: string[] = [];
  let fail: ((e: Error) => void) | null = null;
  const config = {
    configurationValue: 1,
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          interfaceClass: 0xff,
          interfaceSubclass: 0,
          interfaceProtocol: 0,
          endpoints: [
            { endpointNumber: 1, direction: 'in' as const, type: 'interrupt' as const, packetSize: 64 },
            { endpointNumber: 1, direction: 'out' as const, type: 'interrupt' as const, packetSize: 64 },
          ],
        },
      },
      {
        interfaceNumber: 1,
        alternate: {
          interfaceClass: 0x03,
          interfaceSubclass: 0,
          interfaceProtocol: 0,
          endpoints: [
            { endpointNumber: 2, direction: 'in' as const, type: 'interrupt' as const, packetSize: 64 },
            { endpointNumber: 2, direction: 'out' as const, type: 'interrupt' as const, packetSize: 64 },
          ],
        },
      },
    ],
  };
  const device = {
    vendorId: 0x1209,
    productId: 0x53c1,
    productName: 'TREZOR',
    manufacturerName: 'SatoshiLabs',
    configuration: null as typeof config | null,
    configurations: [config],
    opened: false,
    async open() {
      calls.push('open');
      if (opts.openError) throw opts.openError;
      device.opened = true;
    },
    async close() {
      calls.push('close');
      device.opened = false;
      fail?.(Object.assign(new Error('The device was closed.'), { name: 'InvalidStateError' }));
    },
    async selectConfiguration(v: number) {
      calls.push(`config:${v}`);
      device.configuration = config;
    },
    async claimInterface(n: number) {
      calls.push(`claim:${n}`);
      if (opts.claimError) throw opts.claimError;
    },
    async releaseInterface(n: number) {
      calls.push(`release:${n}`);
    },
    async clearHalt() {},
    transferIn(_ep: number, _len: number) {
      const next = incoming.shift();
      if (next) return Promise.resolve({ status: 'ok', data: new DataView(next.buffer) });
      return new Promise<{ status: string; data: DataView }>((resolve, reject) => {
        waiting.push(resolve);
        fail = reject;
      });
    },
    async transferOut(ep: number, data: BufferSource) {
      calls.push(`out:${ep}`);
      sent.push(new Uint8Array(data as ArrayBuffer));
      return { status: 'ok' };
    },
  };
  const deliver = (bytes: number[]) => {
    const packet = new Uint8Array(bytes);
    const w = waiting.shift();
    if (w) w({ status: 'ok', data: new DataView(packet.buffer) });
    else incoming.push(packet);
  };
  const unplug = () => fail?.(Object.assign(new Error('The device was disconnected.'), { name: 'NotFoundError' }));
  return { device: device as unknown as UsbLike, sent, calls, deliver, unplug };
}

const tick = () => new Promise((r) => setImmediate(r));
const describe_ = (e: unknown) => describeWebDeviceError(e, 'Trezor', 'linux');

describe('desktop hardware wallets: which devices', () => {
  it('lists Ledgers, BitBox02 and the old Model One over HID, current Trezors over WebUSB', () => {
    assert.ok(isHidWallet({ vendorId: 0x2c97, productId: 0x5011 }));
    assert.ok(isHidWallet({ vendorId: 0x03eb, productId: 0x2403 }));
    assert.ok(isHidWallet({ vendorId: 0x534c, productId: 0x0001 }));
    assert.ok(!isHidWallet({ vendorId: 0x1209, productId: 0x53c1 }), 'a current Trezor is WebUSB, not HID');
    assert.ok(isUsbWallet({ vendorId: 0x1209, productId: 0x53c1 }));
    assert.ok(!isUsbWallet({ vendorId: 0x1209, productId: 0x1234 }), 'pid.codes is shared: only the Trezor ids');
    assert.ok(!isHidWallet({ vendorId: 0x03eb, productId: 0x2110 }), 'Microchip is shared: only the BitBox02 id');
    assert.ok(!isHidWallet({ vendorId: 0x046d, productId: 0xc52b }), 'a keyboard is nobody’s wallet');
  });

  it('the main process grants exactly the same devices', () => {
    for (const d of [
      { vendorId: 0x2c97, productId: 0x5011 },
      { vendorId: 0x1209, productId: 0x53c1 },
      { vendorId: 0x1209, productId: 0x53c0 },
      { vendorId: 0x534c, productId: 0x0001 },
      { vendorId: 0x03eb, productId: 0x2403 },
    ]) {
      assert.ok(isWalletDevice(d), JSON.stringify(d));
      assert.equal(isWalletDevice(d), isHidWallet(d) || isUsbWallet(d));
    }
    assert.ok(!isWalletDevice({ vendorId: 0x1209, productId: 0x0001 }));
    assert.ok(!isWalletDevice({ vendorId: 0x046d, productId: 0xc52b }));
    assert.ok(!isWalletDevice(null));
    assert.ok(!isWalletDevice({ vendorId: '0x2c97' }), 'Electron hands over numbers; a string is not one');
  });

  it('identifies a Ledger from its HID collection, and ignores its FIDO interface', () => {
    const { device } = fakeHid({ vendorId: 0x2c97, productId: 0x5011 });
    const found = identifyDevice(describeHidDevice('hid-1', device)!);
    assert.deepEqual(
      { kind: found?.kind, model: found?.model, id: found?.id, interfaceIndex: found?.interfaceIndex, hasPermission: found?.hasPermission },
      { kind: 'ledger', model: 'Ledger Nano S Plus', id: 'hid-1', interfaceIndex: 0, hasPermission: true }
    );
    const fido = fakeHid({ vendorId: 0x2c97, productId: 0x5011, collections: [{ usagePage: 0xf1d0, usage: 0x01 }] });
    assert.equal(describeHidDevice('hid-2', fido.device), null);
  });

  it('identifies a BitBox02 over HID by its product name, and its bootloader', () => {
    const box = fakeHid({ vendorId: 0x03eb, productId: 0x2403, productName: 'BitBox02', collections: [{ usagePage: 0xffff, usage: 1 }] });
    assert.equal(identifyDevice(describeHidDevice('h', box.device)!)?.kind, 'bitbox02');
    const bl = fakeHid({ vendorId: 0x03eb, productId: 0x2403, productName: 'bb02-bootloader', collections: [{ usagePage: 0xffff, usage: 1 }] });
    assert.equal(identifyDevice(describeHidDevice('h', bl.device)!)?.bootloader, true);
  });

  it('identifies a Trezor over WebUSB on its vendor interface, before and after configuration', () => {
    const { device } = fakeTrezor();
    const found = identifyDevice(describeUsbDevice('usb-1', device)!);
    assert.equal(found?.kind, 'trezor');
    assert.equal(found?.model, 'Trezor');
    assert.equal(found?.interfaceIndex, 0, 'the vendor interface, not the FIDO one');
    assert.equal(found?.bootloader, false);
  });
});

describe('desktop hardware wallets: HID transport', () => {
  it('sends whole 64-byte reports with report id 0 and reads input reports in order', async () => {
    const hid = fakeHid({ vendorId: 0x2c97, productId: 0x5011 });
    const { transport } = await openHidSession(hid.device, describe_);
    assert.equal(hid.device.opened, true);
    assert.equal(transport.packetSize, 64);
    await transport.write(new Uint8Array([0x01, 0x01, 0x05]));
    assert.equal(hid.sent[0].reportId, 0);
    assert.equal(hid.sent[0].data.length, 64);
    assert.deepEqual([...hid.sent[0].data.slice(0, 4)], [1, 1, 5, 0]);
    hid.report([0xaa, 0xbb]);
    hid.report([0xcc]);
    assert.deepEqual([...(await transport.read(100))], [0xaa, 0xbb], 'only the report, not the buffer around it');
    assert.deepEqual([...(await transport.read(100))], [0xcc]);
    await assert.rejects(transport.read(10), TransportTimeout);
    await assert.rejects(transport.write(new Uint8Array(65)), /too large/);
  });

  it('closing ends the reads, stops listening and closes the device', async () => {
    const hid = fakeHid({ vendorId: 0x2c97, productId: 0x5011 });
    const { transport } = await openHidSession(hid.device, describe_);
    const pending = transport.read(1000);
    await transport.close();
    await assert.rejects(pending, UserCancelled);
    assert.equal(hid.listeners.size, 0);
    assert.equal(hid.device.opened, false);
    await assert.rejects(transport.write(new Uint8Array(1)), /closed/);
  });

  it('an unplugged device fails the read in flight', async () => {
    const hid = fakeHid({ vendorId: 0x2c97, productId: 0x5011 });
    const session = await openHidSession(hid.device, describe_);
    const pending = session.transport.read(1000);
    session.fail(new Error('The device was unplugged.'));
    await assert.rejects(pending, /unplugged/);
  });
});

describe('desktop hardware wallets: WebUSB transport', () => {
  it('configures, claims the interface, and moves packets on its endpoints', async () => {
    const t = fakeTrezor();
    const { transport } = await openUsbSession(t.device, 0, describe_);
    assert.deepEqual(t.calls, ['open', 'config:1', 'claim:0']);
    assert.equal(transport.packetSize, 64);
    await transport.write(new Uint8Array([0x3f, 0x23, 0x23]));
    assert.equal(t.sent[0].length, 64);
    assert.deepEqual([...t.sent[0].slice(0, 3)], [0x3f, 0x23, 0x23]);
    assert.ok(t.calls.includes('out:1'));
    t.deliver([0x3f, 0x01]);
    t.deliver([0x3f, 0x02]);
    assert.deepEqual([...(await transport.read(100))], [0x3f, 0x01]);
    assert.deepEqual([...(await transport.read(100))], [0x3f, 0x02]);
    await transport.close();
    assert.deepEqual(t.calls.slice(-2), ['release:0', 'close']);
  });

  it('a packet that arrives before anyone reads is kept', async () => {
    const t = fakeTrezor();
    const { transport } = await openUsbSession(t.device, 0, describe_);
    t.deliver([0x3f, 0x09]);
    await tick();
    assert.deepEqual([...(await transport.read(100))], [0x3f, 0x09]);
    await transport.close();
  });

  it('closing does not surface the cancelled read as an error', async () => {
    const t = fakeTrezor();
    const { transport } = await openUsbSession(t.device, 0, describe_);
    const pending = transport.read(1000);
    await transport.close();
    await assert.rejects(pending, UserCancelled);
  });

  it('pulling the cable fails the read in flight', async () => {
    const t = fakeTrezor();
    const { transport } = await openUsbSession(t.device, 0, describe_);
    const pending = transport.read(1000);
    await tick();
    t.unplug();
    await assert.rejects(pending, /disconnected/);
  });

  it('explains another program holding the device, and closes it again', async () => {
    const t = fakeTrezor({ claimError: Object.assign(new Error('Unable to claim interface.'), { name: 'NetworkError' }) });
    await assert.rejects(openUsbSession(t.device, 0, describe_), /in use by another program.*Trezor Suite/);
    assert.equal(t.calls.at(-1), 'close');
  });

  it('explains a Linux permission refusal with the udev rule', async () => {
    const t = fakeTrezor({ openError: Object.assign(new Error('Access denied.'), { name: 'SecurityError' }) });
    await assert.rejects(openUsbSession(t.device, 0, describe_), /udev rule/);
    assert.match(describeWebDeviceError(new Error('Access denied.'), 'Ledger', 'darwin').message, /would not let the app open the Ledger\.$/);
  });
});

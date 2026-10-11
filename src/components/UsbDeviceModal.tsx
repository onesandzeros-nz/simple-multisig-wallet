import React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { Button, Divider, Input, Label } from './ui';
import { colors, radius } from '../theme';
import {
  createDriver,
  DeviceInfo,
  DevicePrompts,
  FoundDevice,
  HardwareDevice,
  PacketTransport,
  UserCancelled,
} from '../lib/hw';
import { deviceMemory } from '../lib/hw/memory';
import { listHardwareWallets, openHardwareWallet, watchHardwareWallets } from '../lib/hw/usb';

export interface UsbJob {
  /** Connected and unlocked, ready for commands. */
  device: HardwareDevice;
  info: DeviceInfo;
  found: FoundDevice;
  /** Replaces the line shown while the device is busy. */
  status: (message: string) => void;
}

type Step =
  | { at: 'choose' }
  | { at: 'working'; message: string }
  | { at: 'pin' }
  | { at: 'passphrase'; canEnterOnDevice: boolean }
  | { at: 'pairing'; code: string }
  | { at: 'failed'; message: string };

/** One attempt at talking to a device, so a cancelled one can be told apart from the next. */
interface Attempt {
  cancelled: boolean;
  transport: PacketTransport | null;
  device: HardwareDevice | null;
}

/**
 * Trezor's keypad as the device draws it — 7 8 9 on top. The phone shows the
 * same grid with the digits hidden; the user reads them off the device, so the
 * PIN never appears on the phone and the positions mean nothing next time.
 */
const PIN_GRID = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];

/**
 * Everything between "plug it in" and "done" for a hardware wallet on a USB
 * cable: picking the device, Android's permission dialog, and whatever the
 * device needs from the person holding the phone along the way. What is
 * actually done with the device is up to `run`.
 *
 * Cancelling closes the connection rather than only hiding the dialog, so a
 * device left waiting for a button press is not still waiting afterwards.
 */
export function UsbDeviceModal<T>({
  visible,
  title,
  intro,
  run,
  onDone,
  onCancel,
}: {
  visible: boolean;
  title: string;
  /** Shown above the list of devices. */
  intro: string;
  run: (job: UsbJob) => Promise<T>;
  onDone: (result: T, from: { info: DeviceInfo; found: FoundDevice }) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = React.useState<Step>({ at: 'choose' });
  const [devices, setDevices] = React.useState<FoundDevice[]>([]);
  const [pin, setPin] = React.useState('');
  const [passphrase, setPassphrase] = React.useState('');
  const attempt = React.useRef<Attempt | null>(null);
  // Whoever is waiting on the person: the driver, mid-command.
  const waiting = React.useRef<{ resolve: (value: any) => void; reject: (e: Error) => void } | null>(null);

  const refresh = React.useCallback(() => setDevices(listHardwareWallets()), []);

  /** Ends the attempt in hand, whatever it was doing. */
  const abandon = React.useCallback(() => {
    const current = attempt.current;
    attempt.current = null;
    if (current) {
      current.cancelled = true;
      current.device?.close().catch(() => {});
      current.transport?.close().catch(() => {});
    }
    waiting.current?.reject(new UserCancelled());
    waiting.current = null;
    // Neither a PIN nor a passphrase outlives the dialog that asked for it.
    setPin('');
    setPassphrase('');
  }, []);

  React.useEffect(() => {
    if (!visible) {
      abandon();
      return;
    }
    setStep({ at: 'choose' });
    refresh();
    const stop = watchHardwareWallets(refresh);
    // Not every phone reports a device being plugged in; looking again is cheap.
    const poll = setInterval(refresh, 1500);
    return () => {
      stop();
      clearInterval(poll);
      abandon();
    };
  }, [visible, abandon, refresh]);

  const ask = <V,>(next: Step): Promise<V> =>
    new Promise<V>((resolve, reject) => {
      waiting.current = { resolve, reject };
      setStep(next);
    });

  const answer = (value: unknown) => {
    const asked = waiting.current;
    waiting.current = null;
    setPin('');
    setPassphrase('');
    setStep({ at: 'working', message: 'Waiting for the device…' });
    asked?.resolve(value);
  };

  const connect = async (found: FoundDevice) => {
    if (found.bootloader) {
      setStep({
        at: 'failed',
        message: `The ${found.model} is showing its bootloader, which is for installing firmware. Unplug it, plug it back in without holding any buttons, and try again.`,
      });
      return;
    }
    const mine: Attempt = { cancelled: false, transport: null, device: null };
    attempt.current = mine;
    const status = (message: string) => {
      if (!mine.cancelled) setStep({ at: 'working', message });
    };
    const prompts: DevicePrompts = {
      status,
      pinMatrix: () => ask<string>({ at: 'pin' }),
      passphrase: (canEnterOnDevice) => ask<string | null>({ at: 'passphrase', canEnterOnDevice }),
      confirmPairing: (code) => ask<boolean>({ at: 'pairing', code }),
    };

    status(found.hasPermission ? `Connecting to the ${found.model}…` : 'Allow access when Android asks.');
    try {
      const transport = await openHardwareWallet(found);
      mine.transport = transport;
      if (mine.cancelled) return;
      status(`Connecting to the ${found.model}…`);
      const device = createDriver(found.kind, transport, { prompts, memory: deviceMemory }, found);
      mine.device = device;
      const info = await device.connect();
      if (mine.cancelled) return;
      const result = await run({ device, info, found, status });
      if (mine.cancelled) return;
      attempt.current = null;
      onDone(result, { info, found });
    } catch (e: any) {
      // Cancelling from the phone closes the connection, which fails whatever
      // was in flight; that is the cancellation working, not an error.
      if (mine.cancelled) return;
      if (!(e instanceof UserCancelled)) {
        console.error(`[usb:${found.kind}] ${e?.constructor?.name ?? typeof e}: ${e?.message ?? e}\n${e?.stack ?? ''}`);
      }
      setStep({ at: 'failed', message: String(e?.message ?? e).trim() || 'The device gave no reason.' });
    } finally {
      if (attempt.current === mine) {
        attempt.current = null;
        // A question the driver asked and then stopped waiting on — the
        // device answered first — has nobody left to hear the reply.
        waiting.current = null;
      }
      mine.device?.close().catch(() => {});
      mine.transport?.close().catch(() => {});
    }
  };

  const cancel = () => {
    abandon();
    onCancel();
  };

  const retry = () => {
    abandon();
    refresh();
    setStep({ at: 'choose' });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View
          style={{
            flex: 1,
            backgroundColor: '#000000AA',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <View
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.card,
              padding: 20,
              maxWidth: 380,
              width: '100%',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>{title}</Text>

            {step.at === 'choose' && (
              <>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>{intro}</Text>
                <View style={{ marginTop: 10 }}>
                  {devices.length === 0 ? (
                    <View style={{ alignItems: 'center', paddingVertical: 18 }}>
                      <ActivityIndicator color={colors.inkFaint} />
                      <Text
                        style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 10, textAlign: 'center' }}
                      >
                        Plug your Ledger, Trezor or BitBox02 into this phone and unlock it. It will appear here.
                      </Text>
                    </View>
                  ) : (
                    devices.map((d, i) => (
                      <View key={d.id}>
                        {i > 0 && <Divider />}
                        <TouchableOpacity
                          onPress={() => connect(d)}
                          activeOpacity={0.6}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }}
                        >
                          <Ionicons name="hardware-chip-outline" size={22} color={colors.inkSoft} />
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{d.model}</Text>
                            {d.bootloader && (
                              <Text style={{ fontSize: 12, color: colors.warning }}>In bootloader mode</Text>
                            )}
                          </View>
                          <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
                        </TouchableOpacity>
                      </View>
                    ))
                  )}
                </View>
              </>
            )}

            {step.at === 'working' && (
              <View style={{ alignItems: 'center', paddingVertical: 22 }}>
                <ActivityIndicator color={colors.ink} />
                <Text
                  style={{ color: colors.ink, fontSize: 14, lineHeight: 20, marginTop: 14, textAlign: 'center' }}
                >
                  {step.message}
                </Text>
              </View>
            )}

            {step.at === 'pin' && (
              <>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
                  Your Trezor is showing the digits in a grid. Tap the same positions here — the phone
                  never sees the numbers.
                </Text>
                <Text
                  style={{
                    fontSize: 22,
                    letterSpacing: 4,
                    color: colors.ink,
                    textAlign: 'center',
                    marginTop: 12,
                    minHeight: 30,
                  }}
                >
                  {'•'.repeat(pin.length)}
                </Text>
                <View style={{ gap: 8, marginTop: 4 }}>
                  {[0, 3, 6].map((row) => (
                    <View key={row} style={{ flexDirection: 'row', gap: 8 }}>
                      {PIN_GRID.slice(row, row + 3).map((position) => (
                        <Pressable
                          key={position}
                          onPress={() => pin.length < 50 && setPin(pin + position)}
                          style={({ pressed }) => ({
                            flex: 1,
                            height: 60,
                            borderRadius: radius.control,
                            borderWidth: 1,
                            borderColor: colors.line,
                            backgroundColor: pressed ? colors.chipBg : colors.card,
                            alignItems: 'center',
                            justifyContent: 'center',
                          })}
                        >
                          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.inkSoft }} />
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Delete"
                      icon="backspace-outline"
                      variant="secondary"
                      onPress={() => setPin(pin.slice(0, -1))}
                      disabled={pin.length === 0}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="Unlock" onPress={() => answer(pin)} disabled={pin.length === 0} />
                  </View>
                </View>
              </>
            )}

            {step.at === 'passphrase' && (
              <>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
                  This Trezor has passphrase wallets switched on. Each passphrase opens a different
                  wallet with different keys, so it must be exactly the one this key was made with.
                  Leave it empty for the standard wallet.
                </Text>
                <Label>Passphrase</Label>
                <Input
                  value={passphrase}
                  onChangeText={setPassphrase}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                />
                <View style={{ marginTop: 8 }}>
                  <Button title="Continue" onPress={() => answer(passphrase)} />
                  {step.canEnterOnDevice && (
                    <Button
                      title="Type it on the Trezor instead"
                      icon="hardware-chip-outline"
                      variant="secondary"
                      onPress={() => answer(null)}
                    />
                  )}
                </View>
              </>
            )}

            {step.at === 'pairing' && (
              <>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
                  Your BitBox02 is showing a pairing code. It must be the same as this one — that is
                  what proves nothing sits between the phone and the device. Confirm on the BitBox02
                  as well.
                </Text>
                <View
                  style={{ backgroundColor: colors.monoBg, borderRadius: radius.control, padding: 14, marginTop: 12 }}
                >
                  <Text
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 18,
                      lineHeight: 28,
                      color: colors.ink,
                      textAlign: 'center',
                      letterSpacing: 1,
                    }}
                    selectable
                  >
                    {step.code}
                  </Text>
                </View>
                <View style={{ marginTop: 8 }}>
                  <Button title="They match" icon="checkmark-outline" onPress={() => answer(true)} />
                  <Button title="They are different" variant="danger" onPress={() => answer(false)} />
                </View>
              </>
            )}

            {step.at === 'failed' && (
              <>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
                  <Text style={{ flex: 1, color: colors.ink, fontSize: 14, lineHeight: 20 }}>{step.message}</Text>
                </View>
                <View style={{ marginTop: 10 }}>
                  <Button title="Try again" icon="refresh-outline" onPress={retry} />
                </View>
              </>
            )}

            <Button title="Cancel" variant="ghost" onPress={cancel} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

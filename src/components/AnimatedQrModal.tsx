import React from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './ui';
import { colors, radius } from '../theme';
import type { UREncoder } from '@ngraveio/bc-ur';
import { createPsbtUrEncoder, urFrameCount } from '../lib/qrExport';

const SPEEDS = [
  { label: 'Slow', ms: 500 },
  { label: 'Normal', ms: 250 },
  { label: 'Fast', ms: 120 },
];

/**
 * Displays a PSBT (`base64`) — or whatever `createEncoder` supplies — as an
 * animated BC-UR QR sequence. The QR panel stays white in both themes —
 * scanners need the contrast.
 */
export function AnimatedQrModal({
  visible,
  onClose,
  base64,
  createEncoder,
  title,
  scanner = 'the other phone',
}: {
  visible: boolean;
  onClose: () => void;
  base64?: string;
  /** Overrides `base64`: builds the sequence to show. Keep it stable (useCallback). */
  createEncoder?: () => UREncoder;
  title: string;
  /** What is doing the scanning, for the hint under the title. */
  scanner?: string;
}) {
  const [frame, setFrame] = React.useState('');
  const [speedIndex, setSpeedIndex] = React.useState(1);
  const [total, setTotal] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const counterRef = React.useRef(0);
  const [shown, setShown] = React.useState(0);

  React.useEffect(() => {
    if (!visible) return;
    let encoder: UREncoder;
    try {
      encoder = createEncoder ? createEncoder() : createPsbtUrEncoder(base64 ?? '');
      setTotal(urFrameCount(encoder));
      setError(null);
    } catch (e: any) {
      setError(e.message ?? String(e));
      return;
    }
    counterRef.current = 0;
    const tick = () => {
      setFrame(encoder.nextPart().toUpperCase());
      counterRef.current += 1;
      setShown(counterRef.current);
    };
    tick();
    const id = setInterval(tick, SPEEDS[speedIndex].ms);
    return () => clearInterval(id);
  }, [visible, base64, createEncoder, speedIndex]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: colors.card,
            borderRadius: radius.card,
            padding: 20,
            alignItems: 'center',
            maxWidth: 380,
            width: '100%',
          }}
          onPress={() => {}}
        >
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink, marginBottom: 4 }}>{title}</Text>
          {error ? (
            <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center', marginVertical: 12 }}>
              {error}
            </Text>
          ) : (
            <>
              <Text style={{ color: colors.inkSoft, fontSize: 12, marginBottom: 12, textAlign: 'center' }}>
                {total > 1
                  ? `${total} frames — keep ${scanner} pointed here until it finishes`
                  : `Point ${scanner} at this code`}
              </Text>
              <View style={{ backgroundColor: '#FFFFFF', padding: 12, borderRadius: 12, minHeight: 260, justifyContent: 'center' }}>
                {frame ? <QRCode value={frame} size={236} ecl="L" /> : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <Ionicons name="sync-outline" size={13} color={colors.inkFaint} />
                <Text style={{ color: colors.inkFaint, fontSize: 12 }}>
                  {total > 1 ? `frame ${((shown - 1) % total) + 1} of ${total}` : 'single frame'}
                </Text>
              </View>
              {total > 1 && (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignSelf: 'stretch' }}>
                  {SPEEDS.map((s, i) => {
                    const active = i === speedIndex;
                    return (
                      <TouchableOpacity
                        key={s.label}
                        onPress={() => setSpeedIndex(i)}
                        activeOpacity={0.7}
                        style={{
                          flex: 1,
                          paddingVertical: 8,
                          borderRadius: radius.control,
                          borderWidth: 1,
                          borderColor: active ? colors.ink : colors.line,
                          backgroundColor: active ? colors.ink : colors.card,
                          alignItems: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: '600', color: active ? colors.onPrimary : colors.ink }}>
                          {s.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </>
          )}
          <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

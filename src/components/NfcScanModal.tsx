import React from 'react';
import { Animated, Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './ui';
import { colors, radius } from '../theme';

/**
 * A clear "the NFC reader is active" overlay. Android shows no system NFC UI
 * of its own, so without this a scan looks identical whether it is waiting for
 * a card or has silently failed. iOS has its own scan sheet, so this is only
 * shown there. A pulsing ring signals that the reader is live; Cancel ends the
 * open session.
 */
export function NfcScanModal({
  visible,
  onCancel,
  title = 'Ready to scan',
  message,
}: {
  visible: boolean;
  onCancel: () => void;
  title?: string;
  message: string;
}) {
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 950, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [visible, pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
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
            padding: 24,
            maxWidth: 360,
            width: '100%',
            alignItems: 'center',
          }}
        >
          <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            <Animated.View
              style={{
                position: 'absolute',
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.accent,
                opacity: ringOpacity,
                transform: [{ scale: ringScale }],
              }}
            />
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.chipBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="radio-outline" size={30} color={colors.accent} />
            </View>
          </View>

          <Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink }}>{title}</Text>
          <Text
            style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8 }}
          >
            {message}
          </Text>

          <View style={{ alignSelf: 'stretch', marginTop: 18 }}>
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

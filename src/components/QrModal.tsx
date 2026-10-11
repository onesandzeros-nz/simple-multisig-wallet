import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import QRCode from 'react-native-qrcode-svg';
import { Button } from './ui';
import { colors, radius } from '../theme';

/**
 * Full-screen QR display for in-person exchange. The QR panel stays white
 * in both themes — scanners need the contrast.
 *
 * A `sensitive` code (a group invite: whoever holds it reads the group) is
 * for the camera across the table, not the gallery: while it is up, no
 * screenshots or recordings, and nothing in the app switcher.
 */
export function QrModal({
  visible,
  onClose,
  data,
  title,
  caption,
  sensitive = false,
}: {
  visible: boolean;
  onClose: () => void;
  data: string;
  title: string;
  caption?: string;
  sensitive?: boolean;
}) {
  React.useEffect(() => {
    if (!visible || !sensitive) return;
    preventScreenCaptureAsync('qr').catch(() => {});
    return () => {
      allowScreenCaptureAsync('qr').catch(() => {});
    };
  }, [visible, sensitive]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: '#000000AA',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: colors.card,
            borderRadius: radius.card,
            padding: 20,
            alignItems: 'center',
            maxWidth: 360,
            width: '100%',
          }}
          onPress={() => {}}
        >
          <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink, marginBottom: 12 }}>
            {title}
          </Text>
          <View style={{ backgroundColor: '#FFFFFF', padding: 14, borderRadius: 12 }}>
            <QRCode value={data} size={240} />
          </View>
          {caption && (
            <Text
              style={{
                color: colors.inkSoft,
                fontSize: 12,
                marginTop: 12,
                textAlign: 'center',
                lineHeight: 17,
              }}
            >
              {caption}
            </Text>
          )}
          <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

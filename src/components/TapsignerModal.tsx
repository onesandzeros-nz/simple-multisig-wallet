import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Button, Input, Label } from './ui';
import { colors, radius } from '../theme';

/**
 * Asks for the card's PIN and holds the NFC session open for the tap.
 *
 * Cancelling matters here: an open session waits indefinitely for a card, so
 * `onCancel` must end it rather than only hiding the dialog.
 */
export function TapsignerModal({
  visible,
  cardName,
  busy,
  onSign,
  onCancel,
}: {
  visible: boolean;
  cardName: string;
  busy: boolean;
  onSign: (cvc: string) => void;
  onCancel: () => void;
}) {
  const [cvc, setCvc] = React.useState('');

  // Never keep a PIN around between openings.
  React.useEffect(() => {
    if (!visible) setCvc('');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {/* Tapping the backdrop cancels, except mid-tap when it would be a slip. */}
        <Pressable
          style={{
            flex: 1,
            backgroundColor: '#000000AA',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onPress={busy ? undefined : onCancel}
        >
          <Pressable
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.card,
              padding: 20,
              maxWidth: 360,
              width: '100%',
            }}
            onPress={() => {}}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink }}>
              Sign with {cardName}
            </Text>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
              {busy
                ? 'Hold the card against the back of the phone until signing finishes.'
                : 'Enter the 6-digit code printed on the back of the card.'}
            </Text>

            {!busy && (
              <>
                <Label>Card PIN (CVC)</Label>
                <Input
                  placeholder="123456"
                  value={cvc}
                  onChangeText={setCvc}
                  keyboardType="number-pad"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  maxLength={32}
                />
              </>
            )}

            <View style={{ marginTop: 12 }}>
              <Button
                title={busy ? 'Waiting for the card…' : 'Tap card to sign'}
                icon="radio-outline"
                onPress={() => onSign(cvc.trim())}
                loading={busy}
                disabled={busy || cvc.trim().length < 6}
              />
              <Button title="Cancel" variant="ghost" onPress={onCancel} />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

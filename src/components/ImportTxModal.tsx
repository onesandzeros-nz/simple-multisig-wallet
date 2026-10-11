import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Button, Input, Row, Divider } from './ui';
import { colors, radius } from '../theme';

/**
 * Ways to bring a transaction in for signing: scan an animated QR code, paste
 * the transaction text, or open a transaction file (Sparrow, Nunchuk, and
 * others). Paste opens
 * a text field in place; the other two hand back to the caller.
 */
export function ImportTxModal({
  visible,
  onClose,
  onScan,
  onPickFile,
  onPaste,
}: {
  visible: boolean;
  onClose: () => void;
  onScan: () => void;
  onPickFile: () => void;
  onPaste: (text: string) => void;
}) {
  const [showPaste, setShowPaste] = React.useState(false);
  const [text, setText] = React.useState('');

  React.useEffect(() => {
    if (!visible) {
      setShowPaste(false);
      setText('');
    }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable
          style={{ flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' }}
          onPress={onClose}
        >
          <Pressable
            style={{
              backgroundColor: colors.card,
              borderTopLeftRadius: radius.card,
              borderTopRightRadius: radius.card,
              padding: 20,
              paddingBottom: 32,
            }}
            onPress={() => {}}
          >
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 10 }}>
              Import transaction to sign
            </Text>

            {showPaste ? (
              <>
                <Input
                  placeholder="Paste the transaction here"
                  value={text}
                  onChangeText={setText}
                  multiline
                  style={{ minHeight: 100 }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Button title="Back" variant="ghost" onPress={() => setShowPaste(false)} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="Import" onPress={() => onPaste(text.trim())} disabled={!text.trim()} />
                  </View>
                </View>
              </>
            ) : (
              <>
                <Row
                  icon="scan-outline"
                  title="Scan"
                  subtitle="Read an animated QR code from another wallet"
                  onPress={onScan}
                />
                <Divider />
                <Row
                  icon="clipboard-outline"
                  title="Paste"
                  subtitle="Paste the transaction text (a PSBT)"
                  onPress={() => setShowPaste(true)}
                />
                <Divider />
                <Row
                  icon="document-outline"
                  title="Import file"
                  subtitle="Open a transaction file from Sparrow, Nunchuk and others"
                  onPress={onPickFile}
                />
                <Button title="Cancel" variant="ghost" onPress={onClose} />
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

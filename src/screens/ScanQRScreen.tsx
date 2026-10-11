import React from 'react';
import { Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Screen, Button, Card, EmptyState } from '../components/ui';
import { colors } from '../theme';
import { createQrAssembler } from '../lib/qrParts';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ScanQR'>;

export default function ScanQRScreen({ navigation, route }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [progress, setProgress] = React.useState<string | null>(null);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const assemblerRef = React.useRef(createQrAssembler());
  const doneRef = React.useRef(false);

  if (!permission?.granted) {
    return (
      <Screen>
        <Card>
          <EmptyState
            icon="camera-outline"
            text="Camera access is needed to scan the QR code on your hardware wallet's screen."
          />
          <Button title="Allow camera" onPress={requestPermission} />
        </Card>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (doneRef.current || !data) return;
          try {
            const result = assemblerRef.current.receive(data);
            if (result.done && result.text) {
              doneRef.current = true;
              const { returnTo, walletId, pendingId, keyId } = route.params;
              if (returnTo === 'ImportKey' && keyId) {
                navigation.popTo('ImportKey', { scanned: result.text, verifyKeyId: keyId });
              } else if (returnTo === 'Send') {
                navigation.popTo('Send', { walletId: walletId!, scanned: result.text });
              } else if (returnTo === 'Wallet') {
                navigation.popTo('Wallet', { walletId: walletId!, scanned: result.text });
              } else if (returnTo === 'WalletMenu') {
                navigation.popTo('WalletMenu', { walletId: walletId!, scanned: result.text });
              } else if (returnTo === 'JoinGroup' && walletId) {
                navigation.popTo('JoinGroup', { mode: 'restore', walletId, scanned: result.text });
              } else if (returnTo === 'VerifyBackup') {
                navigation.popTo('VerifyBackup', { walletId: walletId!, scanned: result.text });
              } else if (returnTo === 'Psbt') {
                navigation.popTo('Psbt', {
                  walletId: walletId!,
                  pendingId: pendingId!,
                  scanned: result.text,
                });
              } else {
                navigation.popTo(returnTo, { scanned: result.text });
              }
            } else if (result.progress) {
              setProgress(result.progress);
              setScanError(null);
            }
          } catch (e: any) {
            // Bad frame (mixed transfers, unsupported UR type…): restart clean.
            assemblerRef.current = createQrAssembler();
            setProgress(null);
            setScanError(e.message ?? String(e));
          }
        }}
      />
      <View style={{ position: 'absolute', bottom: 48, left: 20, right: 20, alignItems: 'center' }}>
        {scanError ? (
          <View style={{ backgroundColor: '#00000099', borderRadius: 12, padding: 12 }}>
            <Text style={{ color: '#FF9B9B', fontSize: 13, textAlign: 'center' }}>{scanError}</Text>
          </View>
        ) : (
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '500' }}>
            {progress ? `Keep scanning — ${progress}` : 'Point the camera at the QR code'}
          </Text>
        )}
      </View>
    </View>
  );
}

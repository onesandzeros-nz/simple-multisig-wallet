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
  const [stalled, setStalled] = React.useState(false);
  const assemblerRef = React.useRef(createQrAssembler());
  const doneRef = React.useRef(false);
  const lastProgress = React.useRef<string | null>(null);
  const stallTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
  }, []);

  /**
   * Animated QRs from devices such as Jade loop a fixed set of frames, and a
   * frame the camera keeps missing only comes back on the next pass. When the
   * count stops moving, say so, rather than leave a number that looks stuck.
   */
  const noteProgress = (text: string) => {
    setProgress(text);
    setScanError(null);
    if (text === lastProgress.current) return;
    lastProgress.current = text;
    setStalled(false);
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => setStalled(true), 8000);
  };

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
              noteProgress(result.progress);
            }
          } catch (e: any) {
            // Bad frame (mixed transfers, unsupported UR type…): restart clean.
            assemblerRef.current = createQrAssembler();
            lastProgress.current = null;
            setProgress(null);
            setStalled(false);
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
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '500' }}>
              {progress ? `Keep scanning — ${progress}` : 'Point the camera at the QR code'}
            </Text>
            {stalled && progress ? (
              <Text style={{ color: '#ffffffcc', fontSize: 13, textAlign: 'center', marginTop: 8 }}>
                Some frames were missed. Hold the camera steady on the animation until they come round again.
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

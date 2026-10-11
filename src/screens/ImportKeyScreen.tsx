import React from 'react';
import { Alert, Platform, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, Input, Label, Mono, Tag, SectionTitle, Divider } from '../components/ui';
import { NfcScanModal } from '../components/NfcScanModal';
import { UsbDeviceModal } from '../components/UsbDeviceModal';
import { colors } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId } from '../lib/store';
import { parseKeyImportText, ParsedKeyImport } from '../lib/keyImport';
import { bip32, bip48Path, btcNetwork } from '../lib/bitcoin';
import { isFingerprint } from '../lib/slip132';
import { cancelNfcSession, importFromTapsigner, nfcAvailable, readNdefTexts } from '../lib/nfc';
import { kindName, readKeyFromDevice } from '../lib/hw';
import { usbAvailable } from '../lib/hw/usb';
import { healthCheckHint, recordHealthCheck } from '../lib/keyHealth';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportKey'>;

function HelpSection({ title, children }: { title: string; children: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11 }}
      >
        <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: colors.ink }}>{title}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkFaint} />
      </TouchableOpacity>
      {open && (
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, paddingBottom: 12 }}>
          {children}
        </Text>
      )}
    </View>
  );
}

export default function ImportKeyScreen({ navigation, route }: Props) {
  const { addKey, updateKey, keys, settings } = useStore();
  const [parsed, setParsed] = React.useState<ParsedKeyImport | null>(null);
  const [name, setName] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [hasNfc, setHasNfc] = React.useState(false);
  const [nfcOpen, setNfcOpen] = React.useState(false);
  const [cvc, setCvc] = React.useState('');
  const [tapping, setTapping] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState('');
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [readingTag, setReadingTag] = React.useState(false);
  const [marking, setMarking] = React.useState(false);
  const [usbOpen, setUsbOpen] = React.useState(false);
  const hasUsb = usbAvailable();

  // Health check: read the key from its device again and compare, instead
  // of importing. Every input method below works the same way.
  const verifyKey = route.params?.verifyKeyId
    ? keys.find((k) => k.id === route.params?.verifyKeyId)
    : undefined;
  const matches = !!parsed && !!verifyKey && parsed.xpub === verifyKey.xpub;
  // A device is asked for one particular key, so the network has to be chosen
  // before it is read rather than learned from it: the key being checked, or
  // the network new keys are made on.
  const usbNetwork = verifyKey?.network ?? (settings.testnet ? 'testnet' : 'mainnet');

  React.useEffect(() => {
    nfcAvailable().then(setHasNfc);
  }, []);

  React.useEffect(() => {
    navigation.setOptions({ title: verifyKey ? 'Check key' : 'Import key' });
  }, [verifyKey?.id]);

  const markChecked = async () => {
    if (!verifyKey) return;
    setMarking(true);
    try {
      await updateKey(verifyKey.id, recordHealthCheck(Date.now()));
      Alert.alert('Key checked', `The device still holds “${verifyKey.name}”. The next reminder starts from today.`);
      navigation.goBack();
    } catch (e: any) {
      showError('key:health-check', e);
    } finally {
      setMarking(false);
    }
  };

  const applyKeyText = (text: string, source: string) => {
    try {
      const result = parseKeyImportText(text);
      setParsed(result);
      if (result.name && !name) setName(result.name);
    } catch (e: any) {
      showError(`key:${source}`, e);
    }
  };

  // QR scanner hands its result back via route params.
  React.useEffect(() => {
    if (route.params?.scanned) applyKeyText(route.params.scanned, 'import-qr');
  }, [route.params?.scanned]);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/json', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(result.assets[0].uri);
      applyKeyText(content.trim(), 'import-file');
    } catch (e: any) {
      showError('key:import-file', e);
    }
  };

  // Set when the user taps Cancel, so ending the session is not reported as a
  // failure. A ref because the running scan closes over it.
  const cancelledRead = React.useRef(false);

  const readColdcard = async () => {
    cancelledRead.current = false;
    setReadingTag(true);
    try {
      const texts = await readNdefTexts();
      let lastError: any = new Error('No key found on the NFC tag.');
      for (const text of texts) {
        try {
          const result = parseKeyImportText(text.trim());
          setParsed(result);
          if (result.name && !name) setName(result.name);
          if (!name && !result.name) setName('Coldcard');
          setReadingTag(false);
          return;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    } catch (e: any) {
      if (!cancelledRead.current) showError('key:import-nfc-coldcard', e);
    } finally {
      setReadingTag(false);
    }
  };

  const cancelColdcardRead = () => {
    cancelledRead.current = true;
    cancelNfcSession();
    setReadingTag(false);
  };

  const tapCard = async () => {
    setTapping(true);
    try {
      const key = await importFromTapsigner(cvc.trim());
      setParsed({
        xpub: key.xpub,
        network: 'mainnet',
        fingerprint: key.fingerprint,
        path: key.path,
        source: 'tapsigner',
      });
      if (!name) setName('TAPSIGNER');
      setNfcOpen(false);
    } catch (e: any) {
      showError('key:import-nfc', e);
    } finally {
      setTapping(false);
    }
  };

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      const { xpub, network } = parsed;
      // Only a real fingerprint is saved — eight hex digits, whatever the
      // source — because it is shared with the group as this key's origin.
      let fp = isFingerprint(parsed.fingerprint) ? parsed.fingerprint.toLowerCase() : '';
      if (!fp) {
        // Without the master fingerprint hardware wallets can still verify,
        // but PSBT key-origin info will point at the xpub itself.
        const node = bip32.fromBase58(xpub, btcNetwork(network));
        fp = Buffer.from(node.fingerprint).toString('hex');
      }
      const keyPath = parsed.path ?? bip48Path(network);
      const already = keys.find((k) => k.xpub === xpub);
      if (already) {
        // Same key arriving again: keep it and take anything new, such as
        // learning that it is a card that can sign.
        await updateKey(already.id, {
          name: name.trim() || already.name,
          path: keyPath,
          source: parsed.source ?? already.source,
        });
        const learned = parsed.source && parsed.source !== already.source ? parsed.source : null;
        Alert.alert(
          'Key updated',
          learned === 'tapsigner'
            ? 'You already had this key. It is now marked as a TAPSIGNER, so it can sign by tapping.'
            : learned
              ? `You already had this key. It is now marked as a ${kindName(learned)}, so it can sign over USB.`
              : 'You already had this key, so its details were refreshed.'
        );
        navigation.goBack();
        return;
      }
      await addKey({
        id: newId(),
        name: name.trim() || 'Hardware key',
        type: 'imported',
        fingerprint: fp,
        xpub,
        path: keyPath,
        network,
        source: parsed.source,
        createdAt: Date.now(),
      });
      navigation.goBack();
    } catch (e: any) {
      showError('key:import', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      {verifyKey && (
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>Check “{verifyKey.name}”</Text>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
            {healthCheckHint(verifyKey)} Nothing is imported or changed.
          </Text>
        </Card>
      )}
      <SectionTitle>{verifyKey ? 'Read the key from' : 'Import from'}</SectionTitle>
      <Button
        title="Scan QR code"
        icon="qr-code-outline"
        onPress={() => navigation.navigate('ScanQR', { returnTo: 'ImportKey', keyId: verifyKey?.id })}
      />
      <Button title="Open key file" icon="document-outline" variant="secondary" onPress={pickFile} />
      {hasUsb && (
        <>
          <Button
            title="Connect by USB"
            icon="hardware-chip-outline"
            variant="secondary"
            onPress={() => setUsbOpen(true)}
          />
          <UsbDeviceModal
            visible={usbOpen}
            title={verifyKey ? `Check “${verifyKey.name}”` : 'Import from a USB device'}
            intro={
              usbNetwork === 'testnet'
                ? 'Reads the testnet multisig public key from a Ledger, Trezor or BitBox02. Nothing on the device changes.'
                : 'Reads the multisig public key from a Ledger, Trezor or BitBox02. Nothing on the device changes.'
            }
            run={({ device, found, status }) => {
              status(`Reading the public key from the ${found.model}…`);
              return readKeyFromDevice(device, usbNetwork, verifyKey?.path);
            }}
            onDone={(key, { info, found }) => {
              setUsbOpen(false);
              setParsed({ ...key, source: found.kind });
              if (!name) setName(info.label?.trim() || info.model || found.model);
            }}
            onCancel={() => setUsbOpen(false)}
          />
        </>
      )}
      {hasNfc && (
        <>
          <Button
            title={readingTag ? 'Hold the phone against the Coldcard…' : 'Read Coldcard (NFC)'}
            icon="radio-outline"
            variant="secondary"
            onPress={readColdcard}
            loading={readingTag}
          />
          {/* iOS shows its own scan sheet; Android shows nothing, so make the
              live reader visible there. */}
          <NfcScanModal
            visible={readingTag && Platform.OS === 'android'}
            onCancel={cancelColdcardRead}
            title="Reading Coldcard"
            message="Hold the Coldcard flat against the back of your phone and keep it still. Start the NFC export on the Coldcard if you haven't yet."
          />
          <Button
            title="Tap TAPSIGNER (NFC)"
            icon="radio-outline"
            variant="secondary"
            onPress={() => setNfcOpen(!nfcOpen)}
          />
        </>
      )}
      <Button
        title="Paste key text"
        icon="clipboard-outline"
        variant="ghost"
        onPress={() => setPasteOpen(!pasteOpen)}
      />

      {nfcOpen && (
        <Card>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
            Enter the 6-digit code printed on the back of the card, then hold it against the phone.
          </Text>
          <Label>Card PIN (CVC)</Label>
          <Input
            placeholder="123456"
            value={cvc}
            onChangeText={setCvc}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={32}
          />
          <Button
            title={tapping ? 'Hold the card against the phone…' : 'Tap card to import'}
            icon="radio-outline"
            onPress={tapCard}
            loading={tapping}
            disabled={cvc.trim().length < 6}
          />
        </Card>
      )}

      {pasteOpen && (
        <Card>
          <Input
            placeholder={'Zpub6…  or  [deadbeef/48\'/0\'/0\'/2\']xpub6…'}
            value={pasteText}
            onChangeText={setPasteText}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={{ minHeight: 90 }}
          />
          <Button
            title="Use this key"
            onPress={() => applyKeyText(pasteText, 'import-paste')}
            disabled={!pasteText.trim()}
          />
        </Card>
      )}

      {parsed && verifyKey && (
        <>
          <SectionTitle>Result</SectionTitle>
          <Card style={{ borderColor: matches ? colors.success : colors.danger, borderWidth: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons
                name={matches ? 'checkmark-circle' : 'close-circle'}
                size={20}
                color={matches ? colors.success : colors.danger}
              />
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>
                {matches ? 'It matches' : 'This is a different key'}
              </Text>
            </View>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
              {matches
                ? `The device still holds “${verifyKey.name}” (${verifyKey.fingerprint}).`
                : `The key read has fingerprint ${parsed.fingerprint ?? 'unknown'}, but “${verifyKey.name}” is ${verifyKey.fingerprint}. Check you used the right device, seed and account — if it really has changed, this key can no longer sign for its wallets.`}
            </Text>
            <Mono text={parsed.xpub} small />
          </Card>
          {matches ? (
            <Button title="Mark as checked" icon="checkmark-outline" onPress={markChecked} loading={marking} />
          ) : (
            <Button title="Try again" variant="secondary" onPress={() => setParsed(null)} />
          )}
        </>
      )}

      {parsed && !verifyKey && (
        <>
          <SectionTitle>Key to import</SectionTitle>
          <Card>
            {parsed.network === 'testnet' && (
              <View style={{ flexDirection: 'row' }}>
                <Tag text="Testnet" tone="accent" />
              </View>
            )}
            {/* Labelled so a newcomer knows what to compare against the device. */}
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              Fingerprint {parsed.fingerprint ?? 'unknown'} · path {parsed.path ?? bip48Path(parsed.network)}
            </Text>
            <Label>Public key</Label>
            <Mono text={parsed.xpub} small />
            <Label>Key name</Label>
            <Input placeholder="e.g. Alice's hardware wallet" value={name} onChangeText={setName} />
          </Card>
          <Button title="Import key" onPress={save} loading={saving} />
        </>
      )}

      {helpOpen && (
        <Card>
          <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>
            You're importing a <Text style={{ fontWeight: '600', color: colors.ink }}>public key</Text>{' '}
            (xpub) — enough to build the shared wallet and watch its balance, never enough to
            spend. Find your device below:
          </Text>
          <Divider />
          <HelpSection title="Coldcard">
            {'On the Coldcard: Settings → Multisig Wallets → Export XPUB (or Advanced → Export Wallet → Generic JSON). Save it to the SD card and use Open key file, share it via NFC and use Read Coldcard (NFC), or on a Coldcard Q show it as a QR and use Scan QR.'}
          </HelpSection>
          <Divider />
          <HelpSection title="TAPSIGNER">
            {'Choose Tap TAPSIGNER above, enter the 6-digit PIN printed on the back of the card, then hold the card flat against the back of the phone until the key appears.'}
          </HelpSection>
          <Divider />
          <HelpSection title="SeedSigner">
            {'On the SeedSigner: Seeds → your seed → Export Xpub → Native Segwit (Multisig) → follow the prompts until it shows a QR, then use Scan QR here. Animated (multi-part) QRs are supported — just hold steady until the progress finishes.'}
          </HelpSection>
          <Divider />
          <HelpSection title="Blockstream Jade">
            {'On the Jade: Options → Wallet → Export Xpub, pick the multisig type, and it shows a QR — use Scan QR here.'}
          </HelpSection>
          <Divider />
          <HelpSection title="Ledger, Trezor or BitBox02">
            {hasUsb
              ? 'Plug the device into this phone with a USB cable (a USB-C to USB-C cable, or the device’s own cable with an adapter), unlock it, and choose Connect by USB above. On a Ledger, open the Bitcoin app first. Android asks once whether this app may use the device.\n\nWithout a cable: connect the device to Sparrow Wallet on a computer, add it as a keystore in Settings, and copy the key expression (it looks like [fingerprint/48h/0h/0h/2h]xpub6…). Send it to this phone and use Paste key text, or show it as a QR in Sparrow and Scan QR.'
              : 'None of these exports a multisig xpub on its own, and this phone cannot talk to them over USB. Connect the device to Sparrow Wallet on a computer, open Settings and add it as a keystore, then copy the key expression (it looks like [fingerprint/48h/0h/0h/2h]xpub6…). Send it to this phone and use Paste key text, or show it as a QR in Sparrow and Scan QR.'}
          </HelpSection>
          <Divider />
          <HelpSection title="Another group member">
            {'Ask them to open their key in this app and use Share public key (send it via any messaging app, then Paste key text here) or Show as QR code for an in-person scan.'}
          </HelpSection>
        </Card>
      )}
      <Button
        title={helpOpen ? 'Hide help' : 'How do I import a key?'}
        icon="help-circle-outline"
        variant="ghost"
        onPress={() => setHelpOpen(!helpOpen)}
      />
    </Screen>
  );
}

import React from 'react';
import { Alert, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Screen, Card, Button, SectionTitle, Label, Input, Row } from '../components/ui';
import { colors } from '../theme';
import { useStore } from '../lib/store';
import { RootStackParamList } from '../navigation';
import { MAX_ATTEMPTS, PIN_LENGTH, isValidPin } from '../lib/securityPin';
import { clearPin, savePin } from '../lib/securityMode';
import { clearDecoy, ensureDecoy } from '../lib/decoy/decoyStore';

type Props = NativeStackScreenProps<RootStackParamList, 'SecurityMode'>;

function Para({ children, tone }: { children: React.ReactNode; tone?: 'warning' }) {
  return (
    <Text
      style={{
        color: tone === 'warning' ? colors.warning : colors.inkSoft,
        fontSize: 14,
        lineHeight: 21,
        marginTop: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** Two PIN fields; reports the PIN once both agree. */
function PinForm({ label, onValid }: { label: string; onValid: (pin: string | null) => void }) {
  const [pin, setPin] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const valid = isValidPin(pin);
  const match = valid && pin === confirm;
  React.useEffect(() => onValid(match ? pin : null), [match, pin, onValid]);
  return (
    <>
      <Label>{label}</Label>
      <Input
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, PIN_LENGTH))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_LENGTH}
        placeholder={'•'.repeat(PIN_LENGTH)}
      />
      <Label>Confirm PIN</Label>
      <Input
        value={confirm}
        onChangeText={(t) => setConfirm(t.replace(/\D/g, '').slice(0, PIN_LENGTH))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_LENGTH}
        placeholder={'•'.repeat(PIN_LENGTH)}
      />
      {pin.length > 0 && !valid && (
        <Text style={{ color: colors.inkSoft, fontSize: 13, marginTop: 6 }}>The PIN is {PIN_LENGTH} digits.</Text>
      )}
      {valid && confirm.length === PIN_LENGTH && !match && (
        <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>The two PINs do not match.</Text>
      )}
    </>
  );
}

export default function SecurityModeScreen({ navigation }: Props) {
  const { settings, updateSettings, keys, wallets } = useStore();
  // The PIN is typed here: no screenshots or recordings.
  usePreventScreenCapture();
  const [pin, setPin] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const onValid = React.useCallback((p: string | null) => setPin(p), []);

  const enable = () => {
    if (!pin) return;
    Alert.alert(
      'Turn on security mode?',
      `From the next launch this app opens as "SMS", a messaging app. To get back here, send your PIN as a message in any chat. ${MAX_ATTEMPTS} wrong PINs in a row erase every key and wallet on this phone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn on',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await savePin(pin);
              await ensureDecoy(Date.now());
              await updateSettings({ securityMode: true });
              Alert.alert(
                'Security mode is on',
                'Next time the app opens it will look like a messaging app. Open any chat and send your PIN to unlock.'
              );
              navigation.goBack();
            } catch (e: any) {
              Alert.alert('Could not turn on security mode', e?.message ?? String(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const changePin = async () => {
    if (!pin) return;
    setBusy(true);
    try {
      await savePin(pin);
      setChanging(false);
      Alert.alert('PIN changed', 'Use the new PIN next time the app locks.');
    } catch (e: any) {
      Alert.alert('Could not change the PIN', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = () => {
    Alert.alert('Turn off security mode?', 'The app will open straight to your wallets again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        onPress: async () => {
          setBusy(true);
          try {
            await clearPin();
            // Nothing typed into the decoy is needed again.
            await clearDecoy();
            await updateSettings({ securityMode: false });
            navigation.goBack();
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const unbackedUp = keys.length + wallets.length > 0;

  if (settings.securityMode) {
    return (
      <Screen>
        <Card>
          <Row icon="eye-off-outline" title="Security mode is on" subtitle='The app opens as "SMS"' />
          <Para>
            To unlock, open any conversation and send your {PIN_LENGTH}-digit PIN as a message. The
            message is never shown or kept.
          </Para>
          <Para tone="warning">
            {MAX_ATTEMPTS} wrong PINs in a row erase every key and wallet on this phone. Any
            {' '}{PIN_LENGTH}-digit number sent as a message counts as an attempt.
          </Para>
          <Para>The app locks again after 30 seconds in the background, and whenever it restarts.</Para>
        </Card>

        <SectionTitle>PIN</SectionTitle>
        <Card>
          {changing ? (
            <>
              <PinForm label="New PIN" onValid={onValid} />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <View style={{ flex: 1 }}>
                  <Button title="Cancel" variant="secondary" onPress={() => setChanging(false)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="Save PIN" onPress={changePin} disabled={!pin} loading={busy} />
                </View>
              </View>
            </>
          ) : (
            <Button title="Change PIN" icon="keypad-outline" variant="secondary" onPress={() => setChanging(true)} />
          )}
        </Card>

        <SectionTitle>Turn off</SectionTitle>
        <Card>
          <Button title="Turn off security mode" variant="danger" onPress={disable} loading={busy} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <Row icon="eye-off-outline" title="What security mode does" />
        <Para>
          With security mode on, this app is called "SMS" and opens as an ordinary text messaging
          app: an inbox of conversations with people, that you can read and reply to. Nothing about
          wallets or keys is visible anywhere.
        </Para>
        <Para>
          To get back to your wallets, open any conversation and send your {PIN_LENGTH}-digit PIN
          as a message. The PIN is never shown and the message is not kept, so the chat looks the
          same afterwards.
        </Para>
        <Para tone="warning">
          If a wrong PIN is sent {MAX_ATTEMPTS} times in a row, every key and wallet on this phone
          is erased immediately, with no warning and no way back. The app carries on as a
          messaging app, so nobody can tell it happened.
        </Para>
        <Para tone="warning">
          Any {PIN_LENGTH}-digit number sent as a message counts as an attempt, whoever sends it.
          Only the right PIN clears the count.
        </Para>
        <Para>
          The app locks again after 30 seconds in the background, and whenever it restarts. Turning
          security mode off, or changing the PIN, is done from this screen once unlocked.
        </Para>
        {unbackedUp && (
          <Para tone="warning">
            After a wipe, your recovery phrases and wallet backups are the only way to get your
            funds back. Check they are safe before turning this on.
          </Para>
        )}
      </Card>

      <SectionTitle>Choose a PIN</SectionTitle>
      <Card>
        <PinForm label={`${PIN_LENGTH}-digit PIN`} onValid={onValid} />
        <Para>
          Pick something you will not type by accident — not a date, and not a code you might
          send someone.
        </Para>
      </Card>

      <Button title="Turn on security mode" icon="eye-off-outline" onPress={enable} disabled={!pin} loading={busy} large />
    </Screen>
  );
}

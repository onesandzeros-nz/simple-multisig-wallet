import React from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, Button, Input, Label, Row, Divider } from '../components/ui';
import { colors, radius } from '../theme';
import { showError } from '../lib/errors';
import { useStore, newId, saveMnemonic } from '../lib/store';
import {
  generateMnemonic,
  masterFingerprint,
  bip48Path,
  mnemonicFromDiceRolls,
  validateMnemonic,
} from '../lib/bitcoin';
import { NAME_INPUT_CHARS, NAME_PURPOSE, defaultPhoneKeyName } from '../lib/naming';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateKey'>;

const MIN_ROLLS = 50;
const GOOD_ROLLS = 60;

export default function CreateKeyScreen({ navigation }: Props) {
  const { addKey, keys, settings, updateSettings } = useStore();
  // A new phrase is shown here, or an old one typed in: no screenshots or
  // recordings, and nothing in the app switcher.
  usePreventScreenCapture();
  // The person's name comes first, the one time it is missing: new keys are
  // named after it and it is what cosigners see (naming.ts).
  const hasUserName = (settings.userName ?? '').trim() !== '';
  const [stage, setStage] = React.useState<'name' | 'choose' | 'dice' | 'reveal' | 'restore'>(
    hasUserName ? 'choose' : 'name'
  );
  const [userName, setUserName] = React.useState('');
  const [savingName, setSavingName] = React.useState(false);
  const [rolls, setRolls] = React.useState('');
  // Words typed in to restore a key — kept apart from `mnemonic`, which is
  // only ever a phrase this screen generated or validated.
  const [phrase, setPhrase] = React.useState('');
  const [mnemonic, setMnemonic] = React.useState<string | null>(null);
  const existingNames = keys.map((k) => k.name);
  const [name, setName] = React.useState(() => defaultPhoneKeyName(settings.userName, existingNames));
  const [confirmedBackup, setConfirmedBackup] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // New keys record the path for whichever network is active.
  const network = settings.testnet ? ('testnet' as const) : ('mainnet' as const);
  const rollCount = rolls.length;
  const rollColor =
    rollCount >= GOOD_ROLLS ? colors.success : rollCount >= MIN_ROLLS ? colors.warning : colors.danger;

  const makeFromDice = () => {
    try {
      setMnemonic(mnemonicFromDiceRolls(rolls));
      setStage('reveal');
    } catch (e: any) {
      showError('key:dice', e);
    }
  };

  const continueWithName = async () => {
    const trimmed = userName.trim();
    if (!trimmed) return;
    setSavingName(true);
    try {
      await updateSettings({ userName: trimmed });
      setName(defaultPhoneKeyName(trimmed, existingNames));
      setStage('choose');
    } catch (e: any) {
      showError('key:name', e);
    } finally {
      setSavingName(false);
    }
  };

  const save = async (words: string | null = mnemonic) => {
    if (!words) return;
    setSaving(true);
    try {
      const fingerprint = masterFingerprint(words);
      // Two records of one seed would put a duplicate cosigner in a wallet.
      const existing = keys.find((k) => k.type === 'local' && k.fingerprint === fingerprint);
      if (existing) throw new Error(`That key is already on this phone, as "${existing.name}".`);
      const id = newId();
      await saveMnemonic(id, words);
      await addKey({
        id,
        name: name.trim() || defaultPhoneKeyName(settings.userName, existingNames),
        type: 'local',
        fingerprint,
        path: bip48Path(network),
        createdAt: Date.now(),
      });
      navigation.goBack();
    } catch (e: any) {
      showError('key:create', e);
    } finally {
      setSaving(false);
    }
  };

  /** The typed phrase in the form it is stored and derived from. */
  const restoredWords = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const restoredValid = restoredWords !== '' && validateMnemonic(restoredWords);

  if (stage === 'name') {
    return (
      <Screen>
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>What should others call you?</Text>
          <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>{NAME_PURPOSE}</Text>
          <Label>Your name</Label>
          <Input
            placeholder="e.g. Rob"
            value={userName}
            onChangeText={setUserName}
            maxLength={NAME_INPUT_CHARS}
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={continueWithName}
          />
          <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 8 }}>
            A first name or a nickname is fine. You can change it any time in Settings.
          </Text>
        </Card>
        <Button title="Continue" large onPress={continueWithName} disabled={!userName.trim()} loading={savingName} />
      </Screen>
    );
  }

  if (stage === 'choose') {
    return (
      <Screen>
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>
            Where should the randomness come from?
          </Text>
          <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 13, lineHeight: 19 }}>
            A key is only as good as the randomness behind it. Rolling physical dice means the
            randomness is yours and you don't have to trust the phone. The phone's secure generator
            is the quick alternative.
          </Text>
          <Divider />
          <Row
            icon="dice-outline"
            title="Roll physical dice"
            subtitle={`Recommended — enter at least ${MIN_ROLLS} rolls of a six-sided die`}
            onPress={() => setStage('dice')}
          />
          <Divider />
          <Row
            icon="hardware-chip-outline"
            title="Use the phone's secure random"
            subtitle="Quick — instant"
            onPress={() => {
              setMnemonic(generateMnemonic());
              setStage('reveal');
            }}
          />
        </Card>
        <Card>
          <Row
            icon="refresh-outline"
            title="Restore from a recovery phrase"
            subtitle="Bring back a phone key you wrote down — after a lost phone, say"
            onPress={() => setStage('restore')}
          />
        </Card>
      </Screen>
    );
  }

  if (stage === 'restore') {
    const count = restoredWords ? restoredWords.split(' ').length : 0;
    return (
      <Screen>
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>Restore a phone key</Text>
          <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>
            Type the words of the recovery phrase you wrote down, in order. The same words give the
            same key: wallets that include it can sign with it again, and groups recognise you by it.
          </Text>
          <Label>Recovery phrase</Label>
          <Input
            placeholder="word1 word2 … word12"
            value={phrase}
            onChangeText={setPhrase}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={{ minHeight: 90 }}
          />
          <Text
            style={{
              color: restoredValid ? colors.success : colors.inkFaint,
              fontSize: 13,
              marginTop: 6,
            }}
          >
            {restoredValid
              ? `${count} words · a valid recovery phrase`
              : count === 0
                ? 'Separate the words with spaces.'
                : `${count} word${count === 1 ? '' : 's'} · not a valid recovery phrase yet — check the spelling and order`}
          </Text>
        </Card>

        <Card>
          <Label>Key name</Label>
          <Input placeholder="e.g. Rob's phone" value={name} onChangeText={setName} maxLength={NAME_INPUT_CHARS} />
          <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
            How the key is listed here and in any wallet it joins.
          </Text>
        </Card>

        <Button
          title="Restore key"
          onPress={() => save(restoredWords)}
          disabled={!restoredValid}
          loading={saving}
        />
      </Screen>
    );
  }

  if (stage === 'dice') {
    return (
      <Screen>
        <Card style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>Dice rolls</Text>
          <Text
            style={{
              fontSize: 44,
              fontWeight: '700',
              color: rollColor,
              fontVariant: ['tabular-nums'],
              marginVertical: 4,
            }}
          >
            {rollCount}
          </Text>
          <Text style={{ color: colors.inkSoft, fontSize: 13, textAlign: 'center' }}>
            {rollCount < MIN_ROLLS
              ? `Keep rolling — at least ${MIN_ROLLS} needed (${MIN_ROLLS - rollCount} to go)`
              : rollCount < GOOD_ROLLS
                ? `Enough to generate — ${GOOD_ROLLS} or more is even better`
                : 'Plenty of randomness collected'}
          </Text>
        </Card>

        <Card>
          <Text style={{ color: colors.inkSoft, fontSize: 13, marginBottom: 10 }}>
            Roll a six-sided die and tap the number it shows. Repeat.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => setRolls(rolls + String(n))}
                activeOpacity={0.6}
                style={{
                  width: '31%',
                  paddingVertical: 18,
                  borderRadius: radius.control,
                  borderWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: colors.chipBg,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 24, fontWeight: '700', color: colors.ink }}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button
              title="Undo last roll"
              icon="arrow-undo-outline"
              variant="ghost"
              compact
              onPress={() => setRolls(rolls.slice(0, -1))}
              disabled={rollCount === 0}
            />
          </View>
        </Card>

        <Button title="Generate key from rolls" onPress={makeFromDice} disabled={rollCount < MIN_ROLLS} />
        <Text style={{ color: colors.inkFaint, fontSize: 12, textAlign: 'center', marginTop: 4 }}>
          Rolls are hashed (SHA-256) into the key — {MIN_ROLLS} rolls ≈ 129 bits of entropy.
        </Text>
      </Screen>
    );
  }

  // stage === 'reveal'
  const words = mnemonic!.split(' ');
  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>Recovery phrase</Text>
        <Text style={{ color: colors.inkSoft, marginTop: 6, fontSize: 14, lineHeight: 20 }}>
          These 12 words are the key itself. Write them on paper and store them safely — anyone
          who has them can sign with this key.
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, gap: 8 }}>
          {words.map((w, i) => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colors.monoBg,
                borderRadius: radius.chip,
                paddingHorizontal: 10,
                paddingVertical: 7,
                gap: 6,
                width: '30.5%',
              }}
            >
              <Text style={{ color: colors.inkFaint, fontSize: 12, fontVariant: ['tabular-nums'] }}>
                {i + 1}
              </Text>
              <Text style={{ fontWeight: '600', color: colors.ink, fontSize: 13 }}>{w}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <Label>Key name</Label>
        <Input placeholder="e.g. Rob's phone" value={name} onChangeText={setName} maxLength={NAME_INPUT_CHARS} />
        <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
          How the key is listed here and in any wallet it joins. Cosigners see it too.
        </Text>
      </Card>

      <TouchableOpacity
        onPress={() => setConfirmedBackup(!confirmedBackup)}
        activeOpacity={0.7}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 4 }}
      >
        <Ionicons
          name={confirmedBackup ? 'checkbox-outline' : 'square-outline'}
          size={22}
          color={confirmedBackup ? colors.success : colors.inkSoft}
        />
        <Text style={{ color: colors.ink, fontSize: 15, flex: 1 }}>
          I have written down the 12 words
        </Text>
      </TouchableOpacity>
      <Button title="Save key" onPress={() => save()} disabled={!confirmedBackup} loading={saving} />
      <Text style={{ color: colors.inkFaint, fontSize: 12, textAlign: 'center', marginTop: 4 }}>
        You can view details and share the public key from the Keys tab once saved.
      </Text>
    </Screen>
  );
}

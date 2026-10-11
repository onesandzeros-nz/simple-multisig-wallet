import React from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { Button, Card, IconName, Row } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { NUMBERED_STEPS, STEP_LABELS, TutorialStep } from '../../lib/tutorial';
import { StepProps } from './common';

/** One line per numbered step, so the whole guide fits on one card. */
const BLURBS: Record<TutorialStep, string> = {
  welcome: '',
  policy: 'Answer three questions and get a recommended number of keys and signatures.',
  keys: 'Create or import one key per slot — this phone, other people, hardware signers.',
  create: 'Name the wallet and build it from those keys.',
  backup: 'Save a backup file or print a QR page, then put it somewhere safe.',
  verify: 'Bring the backup back in to prove it restores this wallet.',
  checklist: 'Recovery phrases, a test transaction and other things worth doing once.',
};

/** What a guided setup needs within reach; the guide pauses for anything missing. */
const BEFORE_YOU_START: { icon: IconName; title: string; hint: string }[] = [
  {
    icon: 'pencil-outline',
    title: 'Pen and paper',
    hint: 'Each key made on a phone gives you 12 words to write down. Paper, not a photo or a note on the phone.',
  },
  {
    icon: 'people-outline',
    title: 'The other key holders',
    hint: 'Anyone holding a key on their own phone needs to send you its public key. Have them in the room or reachable by message.',
  },
  {
    icon: 'hardware-chip-outline',
    title: 'Any hardware wallets',
    hint: 'Set up, charged and to hand, so their public keys can be read in.',
  },
  {
    icon: 'print-outline',
    title: 'A printer, if you want one',
    hint: 'For the page of QR codes that backs the wallet up. A saved file does the same job.',
  },
];

export default function WelcomeStep({ draft, go }: StepProps) {
  const { settings, updateSettings, saveSetupDraft } = useStore();

  const startOver = () =>
    Alert.alert('Start over?', 'This forgets the policy and key plan. Keys you created stay in the Keys tab.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start over',
        style: 'destructive',
        onPress: () => saveSetupDraft(null).catch((e) => showError('tutorial:start-over', e)),
      },
    ]);

  return (
    <>
      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>What you'll do</Text>
        <View style={{ marginTop: 10, gap: 10 }}>
          {NUMBERED_STEPS.map((s, i) => (
            <View key={s} style={{ flexDirection: 'row', gap: 12 }}>
              <Text
                style={{
                  color: colors.inkFaint,
                  fontSize: 15,
                  fontWeight: '700',
                  fontVariant: ['tabular-nums'],
                  width: 18,
                  lineHeight: 20,
                }}
              >
                {i + 1}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, lineHeight: 20 }}>
                  {STEP_LABELS[s]}
                </Text>
                <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 1 }}>{BLURBS[s]}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={{ color: colors.inkFaint, fontSize: 13, marginTop: 14 }}>About 15 minutes. Nothing is spent unless you choose to send a test transaction at the end.</Text>
      </Card>

      <Card>
        <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>Before you start</Text>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
          Have these to hand, so the guide does not stall halfway.
        </Text>
        {BEFORE_YOU_START.map((item) => (
          <Row key={item.title} icon={item.icon} title={item.title} subtitle={item.hint} />
        ))}
      </Card>

      <Card>
        <Row
          icon="flask-outline"
          title="Practise with test coins first"
          subtitle="This is the same switch as Settings → Testnet mode. It stays on for every key and wallet you create until you turn it off."
          trailing={
            <Switch
              value={settings.testnet}
              onValueChange={(v) => updateSettings({ testnet: v })}
              trackColor={{ false: colors.chipBg, true: colors.warning }}
              thumbColor={colors.card}
            />
          }
        />
      </Card>

      <Button title="Start" large onPress={() => go('policy')} />
      {draft && <Button title="Start over" variant="danger" onPress={startOver} />}
    </>
  );
}

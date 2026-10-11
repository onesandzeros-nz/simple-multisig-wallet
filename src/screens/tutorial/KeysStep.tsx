import React from 'react';
import { Share, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card, Row, SectionTitle, Tag } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { SignerKey } from '../../lib/types';
import { cosignerInstructions, slotLabels } from '../../lib/tutorialPolicy';
import {
  assignKey,
  assignNewestKey,
  clearSlot,
  draftProgress,
  keySelectionWarnings,
  keysStepDone,
  markInstructionsSent,
  resolveSlots,
} from '../../lib/tutorial';
import { NoticeCard, StepProps } from './common';

export default function KeysStep({ draft, go, navigation }: StepProps) {
  const { keys, settings, saveSetupDraft } = useStore();
  /** The slot the user left for CreateKey / ImportKey, and when — the key made after that fills it. */
  const pending = React.useRef<{ slot: number; since: number } | null>(null);
  /** Which slot has its "Use an existing key" list open. */
  const [picking, setPicking] = React.useState<number | null>(null);

  // Back from CreateKey / ImportKey: the key just added goes into the slot that was tapped.
  React.useEffect(() => {
    const p = pending.current;
    if (!p || !draft) return;
    try {
      const next = assignNewestKey(draft, keys, p.slot, p.since);
      if (next !== draft) {
        pending.current = null;
        saveSetupDraft(next).catch((e) => showError('tutorial:assign', e));
      }
    } catch (e: any) {
      // A duplicate fingerprint: the slot stays empty and the key waits under "Use an existing key".
      pending.current = null;
      showError('tutorial:assign', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.length]);

  if (!draft) return null;

  const slots = resolveSlots(draft, keys);
  const slotKeys = slots.flatMap((s) => (s.key ? [s.key] : []));
  const { m, n } = draft.policy;
  const issues = keySelectionWarnings(slotKeys, m, n, settings.testnet);
  const assigned = new Set(slotKeys.map((k) => k.id));
  const unassigned = keys.filter((k) => !assigned.has(k.id));
  const progress = draftProgress(draft, keys);

  const leaveFor = (slot: number, screen: 'CreateKey' | 'ImportKey') => {
    pending.current = { slot, since: Date.now() };
    if (screen === 'CreateKey') navigation.navigate('CreateKey');
    else navigation.navigate('ImportKey');
  };

  const assign = (slot: number, key: SignerKey) => {
    try {
      const next = assignKey(draft, slot, key, keys);
      setPicking(null);
      saveSetupDraft(next).catch((e) => showError('tutorial:assign', e));
    } catch (e: any) {
      showError('tutorial:assign', e);
    }
  };

  const change = (slot: number) => {
    saveSetupDraft(clearSlot(draft, slot)).catch((e) => showError('tutorial:keys', e));
  };

  // Hands the other person a ready-made message. The slot remembers that it
  // went out, so the guide can be left until their key arrives.
  const sendInstructions = async (slot: number) => {
    try {
      const result = await Share.share({ message: cosignerInstructions({ testnet: settings.testnet }) });
      if (result.action === Share.dismissedAction) return;
      await saveSetupDraft(markInstructionsSent(draft, slot, Date.now()));
    } catch (e: any) {
      showError('tutorial:instructions', e);
    }
  };

  return (
    <>
      <SectionTitle>
        Keys · {progress.filled} of {progress.total} added
      </SectionTitle>
      {slots.map(({ index: i, slot, key }) => {
        const label = slotLabels(slot, i);
        return (
          <Card key={i} style={key ? { borderColor: colors.success, borderWidth: 1 } : undefined}>
            <Row icon={label.icon} title={label.title} subtitle={label.hint} />
            {key ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <Ionicons name="checkmark-circle" size={24} color={colors.success} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{key.name}</Text>
                    <View style={{ flexDirection: 'row', marginTop: 6, flexWrap: 'wrap' }}>
                      <Tag text={key.type === 'local' ? 'This phone' : 'Hardware wallet'} />
                      {key.network === 'testnet' && <Tag text="Testnet" tone="accent" />}
                    </View>
                  </View>
                  <Button title="Change" variant="ghost" compact onPress={() => change(i)} />
                </View>
                {slot.kind === 'hardware' && key.type === 'local' && (
                  <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
                    This slot was planned for a hardware signer.
                  </Text>
                )}
              </>
            ) : (
              <>
                {slot.kind === 'this-phone' && (
                  <Button
                    title="Create on this phone"
                    icon="phone-portrait-outline"
                    compact
                    onPress={() => leaveFor(i, 'CreateKey')}
                  />
                )}
                {slot.kind === 'other-phone' && (
                  <>
                    {slot.instructionsSentAt !== undefined && (
                      <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>
                        Instructions sent {new Date(slot.instructionsSentAt).toLocaleDateString()} · waiting for
                        their key
                      </Text>
                    )}
                    <Button
                      title={slot.instructionsSentAt !== undefined ? 'Send again' : 'Send instructions'}
                      icon="paper-plane-outline"
                      variant="secondary"
                      compact
                      onPress={() => sendInstructions(i)}
                    />
                    <Button
                      title="Import their key"
                      icon="download-outline"
                      compact
                      onPress={() => leaveFor(i, 'ImportKey')}
                    />
                  </>
                )}
                {slot.kind === 'hardware' && (
                  <Button
                    title="Import from device"
                    icon="hardware-chip-outline"
                    compact
                    onPress={() => leaveFor(i, 'ImportKey')}
                  />
                )}
                {slot.kind === 'hardware' && slot.toAcquire && settings.testnet && (
                  <>
                    <Button
                      title="Create a practice key on this phone"
                      variant="ghost"
                      compact
                      onPress={() => leaveFor(i, 'CreateKey')}
                    />
                    <Text style={{ color: colors.inkFaint, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
                      Only for practising with test coins — for real money this key must live on another device.
                    </Text>
                  </>
                )}
                <Button
                  title="Use an existing key"
                  variant="ghost"
                  compact
                  onPress={() => setPicking((cur) => (cur === i ? null : i))}
                />
                {picking === i &&
                  (unassigned.length === 0 ? (
                    <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                      Every key on this phone is already in a slot.
                    </Text>
                  ) : (
                    unassigned.map((k) => (
                      <Row
                        key={k.id}
                        icon={k.type === 'local' ? 'phone-portrait-outline' : 'hardware-chip-outline'}
                        title={k.name}
                        subtitle={k.fingerprint}
                        onPress={() => assign(i, k)}
                      />
                    ))
                  ))}
              </>
            )}
          </Card>
        );
      })}

      {issues.blocking.map((b, i) => (
        <Text key={i} style={{ color: colors.danger, fontSize: 13, lineHeight: 19, marginBottom: 8, marginHorizontal: 4 }}>
          {b}
        </Text>
      ))}
      {issues.warnings.length > 0 && <NoticeCard tone="warning" lines={issues.warnings} />}

      <Button
        title="Continue"
        large
        disabled={!keysStepDone(draft, keys, settings.testnet)}
        onPress={() => go('create')}
      />
    </>
  );
}

import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card } from '../../components/ui';
import { colors } from '../../theme';
import { MultisigWallet, SetupDraft } from '../../lib/types';
import { NUMBERED_STEPS, TutorialStep } from '../../lib/tutorial';
import { RootStackParamList } from '../../navigation';

/** What every step of the guide receives from TutorialScreen. */
export interface StepProps {
  draft: SetupDraft | null;
  wallet?: MultisigWallet;
  go: (step: TutorialStep) => void;
  navigation: NativeStackScreenProps<RootStackParamList, 'Tutorial'>['navigation'];
}

/** Six dots under the header: done, current, still to come. */
export function StepProgress({ current, done }: { current: TutorialStep; done: Set<TutorialStep> }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
      {NUMBERED_STEPS.map((s) => (
        <View
          key={s}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: s === current ? colors.ink : done.has(s) ? colors.success : colors.line,
          }}
        />
      ))}
    </View>
  );
}

/** A selectable answer: bordered card with a check mark when chosen. */
export function OptionRow({
  selected,
  title,
  subtitle,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      <Card style={{ borderColor: selected ? colors.ink : colors.line, borderWidth: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Ionicons
            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
            size={24}
            color={selected ? colors.ink : colors.inkFaint}
          />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>{title}</Text>
            {subtitle ? (
              <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{subtitle}</Text>
            ) : null}
          </View>
        </View>
      </Card>
    </TouchableOpacity>
  );
}

/** A checkbox line the user ticks to confirm something they did. */
export function CheckRow({
  checked,
  label,
  onPress,
  disabled,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}
    >
      <Ionicons
        name={checked ? 'checkbox-outline' : 'square-outline'}
        size={22}
        color={disabled ? colors.inkFaint : checked ? colors.success : colors.inkSoft}
      />
      <Text style={{ color: disabled ? colors.inkFaint : colors.ink, fontSize: 14, lineHeight: 19, flex: 1 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export type NoticeTone = 'success' | 'warning' | 'danger' | 'accent';

/** A bordered card that calls something out: a warning, a success, a hint. */
export function NoticeCard({
  tone,
  title,
  lines,
  children,
}: {
  tone: NoticeTone;
  title?: string;
  lines: string[];
  children?: React.ReactNode;
}) {
  const icon = tone === 'success' ? 'checkmark-circle' : 'alert-circle-outline';
  return (
    <Card style={{ borderColor: colors[tone], borderWidth: 1 }}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name={icon} size={20} color={colors[tone]} />
          <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink, flex: 1 }}>{title}</Text>
        </View>
      ) : null}
      {lines.map((l, i) => (
        <Text key={i} style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: i === 0 && title ? 8 : 6 }}>
          {l}
        </Text>
      ))}
      {children}
    </Card>
  );
}

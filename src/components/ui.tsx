import React from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow, themeKey } from '../theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

// Styles are rebuilt whenever the theme palette changes.
let cachedFor = '';
let cached: ReturnType<typeof buildStyles>;
function getStyles() {
  if (cachedFor !== themeKey()) {
    cached = buildStyles();
    cachedFor = themeKey();
  }
  return cached;
}

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const styles = getStyles();
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return (
    // Scrolls a focused field above the keyboard instead of letting the
    // keyboard cover it — every form screen in the app renders through here.
    <KeyboardAwareScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: 20, paddingBottom: 56 }}
      bottomOffset={20}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const styles = getStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  icon,
  variant = 'primary',
  disabled,
  loading,
  compact,
  large,
}: {
  title: string;
  onPress: () => void;
  icon?: IconName;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  /** Taller target for the primary action at the bottom of a flow. */
  large?: boolean;
}) {
  const styles = getStyles();
  const stylesByVariant: Record<ButtonVariant, { box: ViewStyle; text: string }> = {
    primary: { box: { backgroundColor: colors.primary }, text: colors.onPrimary },
    secondary: {
      box: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
      text: colors.ink,
    },
    ghost: { box: { backgroundColor: 'transparent' }, text: colors.accent },
    danger: { box: { backgroundColor: 'transparent' }, text: colors.danger },
  };
  const v = stylesByVariant[variant];
  const textColor = disabled ? colors.inkFaint : v.text;
  return (
    <TouchableOpacity
      style={[
        styles.button,
        v.box,
        compact && styles.buttonCompact,
        large && styles.buttonLarge,
        disabled && variant === 'primary' && { backgroundColor: colors.chipBg },
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.onPrimary : colors.ink} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon && <Ionicons name={icon} size={18} color={textColor} />}
          <Text style={[styles.buttonText, large && styles.buttonTextLarge, { color: textColor }]}>
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const styles = getStyles();
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  const styles = getStyles();
  return <Text style={styles.label}>{children}</Text>;
}

export function Input(props: React.ComponentProps<typeof TextInput>) {
  const styles = getStyles();
  return <TextInput placeholderTextColor={colors.inkFaint} {...props} style={[styles.input, props.style]} />;
}

/** Monospace block with tap-to-copy. */
export function Mono({ text, small }: { text: string; small?: boolean }) {
  const styles = getStyles();
  const [copied, setCopied] = React.useState(false);
  return (
    <TouchableOpacity
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      activeOpacity={0.7}
    >
      <View style={styles.mono}>
        <Text style={[styles.monoText, small && { fontSize: 11 }]} selectable>
          {text}
        </Text>
        <View style={styles.copyRow}>
          <Ionicons
            name={copied ? 'checkmark-outline' : 'copy-outline'}
            size={13}
            color={copied ? colors.success : colors.inkFaint}
          />
          <Text style={[styles.copyHint, copied && { color: colors.success }]}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

type TagTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export function Tag({
  text,
  tone = 'neutral',
  icon,
}: {
  text: string;
  tone?: TagTone;
  icon?: IconName;
}) {
  const styles = getStyles();
  const tones: Record<TagTone, { bg: string; fg: string }> = {
    neutral: { bg: colors.chipBg, fg: colors.inkSoft },
    success: { bg: colors.successBg, fg: colors.success },
    warning: { bg: colors.warningBg, fg: colors.warning },
    danger: { bg: colors.dangerBg, fg: colors.danger },
    accent: { bg: colors.chipBg, fg: colors.accent },
  };
  const t = tones[tone];
  return (
    <View style={[styles.tag, { backgroundColor: t.bg, flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
      {icon && <Ionicons name={icon} size={11} color={t.fg} />}
      <Text style={{ color: t.fg, fontWeight: '600', fontSize: 12 }}>{text}</Text>
    </View>
  );
}

/** List row: icon, title/subtitle, trailing chevron or element. */
export function Row({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
  destructive,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  destructive?: boolean;
}) {
  const styles = getStyles();
  const content = (
    <View style={styles.row}>
      {icon && (
        <View style={styles.rowIcon}>
          <Ionicons name={icon} size={20} color={destructive ? colors.danger : colors.inkSoft} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, destructive && { color: colors.danger }]}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {trailing ?? (onPress && <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />)}
    </View>
  );
  if (!onPress) return content;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6}>
      {content}
    </TouchableOpacity>
  );
}

export function EmptyState({ icon, text }: { icon: IconName; text: string }) {
  const styles = getStyles();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 28 }}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={colors.inkFaint} />
      </View>
      <Text style={{ color: colors.inkSoft, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

/** Unread marker: a dot on its own, or a count when there is room. */
export function UnreadDot({
  count,
  showCount,
  tone = 'accent',
}: {
  count: number;
  showCount?: boolean;
  /** Accent for things that arrived; warning for things that are overdue. */
  tone?: 'accent' | 'warning';
}) {
  if (count <= 0) return null;
  const bg = tone === 'warning' ? colors.warning : colors.accent;
  if (!showCount) {
    return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: bg }} />;
  }
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        paddingHorizontal: 6,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

export function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />;
}

/** A labelled +/- number picker, clamped to [min, max]. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ color: colors.inkSoft, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <TouchableOpacity onPress={() => onChange(Math.max(min, value - 1))} hitSlop={8}>
          <Ionicons name="remove-circle-outline" size={28} color={colors.inkSoft} />
        </TouchableOpacity>
        <Text
          style={{ fontSize: 26, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'], minWidth: 28, textAlign: 'center' }}
        >
          {value}
        </Text>
        <TouchableOpacity onPress={() => onChange(Math.min(max, value + 1))} hitSlop={8}>
          <Ionicons name="add-circle-outline" size={28} color={colors.inkSoft} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function buildStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.line,
      padding: 16,
      marginBottom: 12,
      ...shadow,
    },
    button: {
      borderRadius: radius.control,
      paddingVertical: 15,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 5,
      minHeight: 50,
    },
    buttonCompact: { paddingVertical: 10, minHeight: 40, marginVertical: 3 },
    buttonLarge: { paddingVertical: 19, minHeight: 60, borderRadius: 14 },
    buttonText: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1 },
    buttonTextLarge: { fontSize: 17 },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.inkFaint,
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginTop: 16,
      marginBottom: 8,
      marginLeft: 4,
    },
    label: { fontSize: 13, fontWeight: '600', color: colors.inkSoft, marginBottom: 6, marginTop: 12 },
    input: {
      backgroundColor: colors.card,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: radius.control,
      padding: 13,
      fontSize: 15,
      color: colors.ink,
    },
    mono: {
      backgroundColor: colors.monoBg,
      borderRadius: radius.control,
      padding: 12,
      marginVertical: 4,
    },
    monoText: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 12.5,
      color: colors.ink,
      lineHeight: 18,
    },
    copyRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8, alignSelf: 'flex-end' },
    copyHint: { fontSize: 12, color: colors.inkFaint, fontWeight: '500' },
    tag: {
      borderRadius: radius.chip,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignSelf: 'flex-start',
      marginRight: 6,
      marginBottom: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      gap: 12,
    },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.chipBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
    rowSubtitle: { fontSize: 13, color: colors.inkSoft, marginTop: 1 },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.chipBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
    },
  });
}

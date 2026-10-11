import React from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Row, SectionTitle, Stepper, Tag } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { KeyPlanSlot, Owners, PolicyAnswers, SetupPolicy } from '../../lib/types';
import { MAX_KEYS, planKeys, policyTradeoffs, recommendPolicy, slotLabels } from '../../lib/tutorialPolicy';
import { newDraft, setDraftPolicy } from '../../lib/tutorial';
import { NoticeCard, OptionRow, StepProps } from './common';

const OWNER_OPTIONS: { id: Owners; title: string; subtitle: string }[] = [
  { id: 'me', title: 'Just me', subtitle: 'You hold every key yourself' },
  { id: 'pair', title: 'Me and one other person', subtitle: 'A partner, a co-founder…' },
  { id: 'group', title: 'Three or more of us', subtitle: 'A family, a club, a small business' },
];

const DEVICE_OPTIONS: { id: PolicyAnswers['hardwareDevices']; title: string }[] = [
  { id: 0, title: 'None yet' },
  { id: 1, title: 'One' },
  { id: 2, title: 'Two' },
  { id: 3, title: 'Three or more' },
];

const STAKES_OPTIONS: { id: PolicyAnswers['stakes']; title: string; subtitle: string }[] = [
  { id: 'modest', title: 'Pocket money or a first try', subtitle: 'Something you could afford to lose while you learn' },
  { id: 'serious', title: 'Real savings', subtitle: 'Money you would hate to lose' },
];

/** The user's own m-of-n instead of the recommendation, with its re-planned slots. */
interface Override {
  m: number;
  n: number;
  slots: KeyPlanSlot[];
}

function complete(a: Partial<PolicyAnswers>): a is PolicyAnswers {
  return a.owners !== undefined && a.people !== undefined && a.hardwareDevices !== undefined && a.stakes !== undefined;
}

function isOverride(p: SetupPolicy): boolean {
  return p.m !== p.recommendedM || p.n !== p.recommendedN;
}

export default function PolicyStep({ draft, go }: StepProps) {
  const { saveSetupDraft } = useStore();
  const [answers, setAnswers] = React.useState<Partial<PolicyAnswers>>(() => (draft ? { ...draft.answers } : {}));
  const [adjust, setAdjust] = React.useState<boolean>(() => !!draft && isOverride(draft.policy));
  // A draft that already went against the recommendation comes back as it was.
  const [override, setOverride] = React.useState<Override | null>(() =>
    draft && isOverride(draft.policy)
      ? { m: draft.policy.m, n: draft.policy.n, slots: planKeys(draft.answers, draft.policy.n) }
      : null
  );
  const [saving, setSaving] = React.useState(false);

  // Any change to an answer changes the recommendation, so an override no longer applies.
  const answer = (patch: Partial<PolicyAnswers>) => {
    setAnswers((cur) => ({ ...cur, ...patch }));
    setOverride(null);
  };
  const pickOwners = (owners: Owners) =>
    answer({ owners, people: owners === 'me' ? 1 : owners === 'pair' ? 2 : Math.max(3, answers.people ?? 3) });

  const full = complete(answers) ? answers : null;
  const rec = full ? recommendPolicy(full) : null;
  const m = override?.m ?? rec?.m ?? 0;
  const n = override?.n ?? rec?.n ?? 0;
  const slots = override?.slots ?? rec?.slots ?? [];
  const overridden = !!rec && (m !== rec.m || n !== rec.n);
  const tradeoffs = policyTradeoffs(m, n);

  const accept = async () => {
    if (!full || !rec) return;
    setSaving(true);
    try {
      const policy: SetupPolicy = { m, n, recommendedM: rec.m, recommendedN: rec.n, slots };
      await saveSetupDraft(draft ? setDraftPolicy(draft, full, policy) : newDraft(full, policy, Date.now()));
      go('keys');
    } catch (e: any) {
      showError('tutorial:policy', e);
    } finally {
      setSaving(false);
    }
  };

  const question = { fontSize: 17, fontWeight: '600' as const, color: colors.ink, marginTop: 8, marginBottom: 10 };
  const line = { color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 6 };

  return (
    <>
      <Text style={question}>Who will control the money?</Text>
      {OWNER_OPTIONS.map((o) => (
        <OptionRow
          key={o.id}
          selected={answers.owners === o.id}
          title={o.title}
          subtitle={o.subtitle}
          onPress={() => pickOwners(o.id)}
        />
      ))}
      {answers.owners === 'group' && (
        <Card>
          <Stepper
            label="People"
            value={answers.people ?? 3}
            min={3}
            max={MAX_KEYS}
            onChange={(v) => answer({ people: v })}
          />
        </Card>
      )}

      <Text style={question}>How many hardware signing devices do you have?</Text>
      <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19, marginTop: -6, marginBottom: 10 }}>
        Coldcard, TAPSIGNER, SeedSigner, Jade, Trezor, Ledger… across everyone
      </Text>
      {DEVICE_OPTIONS.map((o) => (
        <OptionRow
          key={o.id}
          selected={answers.hardwareDevices === o.id}
          title={o.title}
          onPress={() => answer({ hardwareDevices: o.id })}
        />
      ))}

      <Text style={question}>How much will it hold?</Text>
      {STAKES_OPTIONS.map((o) => (
        <OptionRow
          key={o.id}
          selected={answers.stakes === o.id}
          title={o.title}
          subtitle={o.subtitle}
          onPress={() => answer({ stakes: o.id })}
        />
      ))}

      {full && rec && (
        <>
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <Tag text={overridden ? 'Adjusted' : 'Recommended'} tone={overridden ? 'warning' : 'accent'} />
            </View>
            <Text
              style={{
                fontSize: 32,
                fontWeight: '700',
                color: colors.ink,
                fontVariant: ['tabular-nums'],
                letterSpacing: -0.5,
                marginTop: 6,
              }}
            >
              {m} of {n}
            </Text>
            {overridden ? (
              <Text style={line}>
                The recommendation was {rec.m} of {rec.n}.
              </Text>
            ) : (
              rec.reasons.map((r, i) => (
                <Text key={i} style={line}>
                  • {r}
                </Text>
              ))
            )}
            <SectionTitle>Where the keys should live</SectionTitle>
            {slots.map((s, i) => {
              const l = slotLabels(s, i);
              return <Row key={i} icon={l.icon} title={l.title} subtitle={l.hint} />;
            })}
          </Card>

          {rec.warnings.length > 0 && <NoticeCard tone="warning" lines={rec.warnings} />}

          <Card>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.ink }}>Other options</Text>
            {rec.alternatives.map((alt) => (
              <Text
                key={`${alt.m}-${alt.n}`}
                style={{ ...line, color: alt.m === alt.n ? colors.danger : colors.inkSoft }}
              >
                {alt.m} of {alt.n} — {alt.when}
              </Text>
            ))}
            <Button title="Adjust" variant="ghost" onPress={() => setAdjust((a) => !a)} />
            {adjust && (
              <>
                <View style={{ flexDirection: 'row' }}>
                  <Stepper
                    label="Keys in total"
                    value={n}
                    min={2}
                    max={MAX_KEYS}
                    onChange={(v) => setOverride({ n: v, m: Math.min(m, v), slots: planKeys(full, v) })}
                  />
                  <Stepper
                    label="Needed to sign"
                    value={m}
                    min={1}
                    max={n}
                    onChange={(v) => setOverride({ m: v, n, slots })}
                  />
                </View>
                <Text
                  style={{
                    color: colors[tradeoffs.tone],
                    textAlign: 'center',
                    marginTop: 12,
                    fontSize: 13,
                    lineHeight: 19,
                  }}
                >
                  {tradeoffs.lines.join(' ')}
                </Text>
              </>
            )}
          </Card>

          <Button title={`Use ${m} of ${n}`} large onPress={accept} loading={saving} />
        </>
      )}
    </>
  );
}

import React from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Input, Label, Row, Tag } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { loadMnemonic, newId, useStore } from '../../lib/store';
import { NetworkName } from '../../lib/types';
import { buildPrivateWallet, resolveWalletNetwork } from '../../lib/buildWallet';
import { slotLabels } from '../../lib/tutorialPolicy';
import { keysStepDone, resolveSlots, startSetup } from '../../lib/tutorial';
import { StepProps } from './common';

export default function CreateStep({ draft, wallet, go, navigation }: StepProps) {
  const { keys, settings, addWallet, saveSetupDraft } = useStore();
  const [name, setName] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  // Right after creation the route already carries the wallet; the draft is gone.
  if (wallet) {
    return (
      <>
        <Card>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>{wallet.name}</Text>
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <Tag text={`${wallet.m} of ${wallet.n}`} tone="success" />
            <Tag text={wallet.network} tone={wallet.network === 'testnet' ? 'accent' : 'neutral'} />
          </View>
          {wallet.cosigners.map((c) => {
            const held = keys.find((k) => k.id === c.keyId);
            const where = held?.type === 'local' ? 'On this phone' : held?.source ? 'Hardware wallet' : undefined;
            return <Row key={c.fingerprint + c.xpub} icon="key-outline" title={c.name} subtitle={where} />;
          })}
        </Card>
        <Button title="Continue" large onPress={() => go('backup')} />
      </>
    );
  }

  if (!draft) return null;

  const resolved = resolveSlots(draft, keys);
  const slotKeys = resolved.flatMap((s) => (s.key ? [s.key] : []));
  const { m, n } = draft.policy;
  const defaultNetwork: NetworkName = settings.testnet ? 'testnet' : 'mainnet';
  let network: NetworkName | null = null;
  let networkError: string | null = null;
  try {
    network = resolveWalletNetwork(slotKeys, defaultNetwork);
  } catch (e: any) {
    networkError = e.message ?? String(e);
  }
  // Every slot must still resolve to a key: one deleted since the Keys step would shrink the wallet.
  const ready = keysStepDone(draft, keys, settings.testnet);

  const create = async () => {
    setSaving(true);
    try {
      const built = await buildPrivateWallet({
        id: newId(),
        keys: slotKeys,
        m: draft.policy.m,
        name,
        defaultNetwork,
        loadMnemonic,
        now: Date.now(),
      });
      await addWallet({ ...built, setup: startSetup(draft, Date.now()) });
      navigation.setParams({ walletId: built.id });
      await saveSetupDraft(null);
      go('backup');
    } catch (e: any) {
      showError('tutorial:create', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <Label>Wallet name</Label>
        <Input placeholder="e.g. Family savings" value={name} onChangeText={setName} />
      </Card>

      <Card>
        <View style={{ flexDirection: 'row' }}>
          <Tag text={`${m} of ${n}`} tone="success" />
        </View>
        {networkError ? (
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19, marginTop: 6 }}>{networkError}</Text>
        ) : (
          <Text
            style={{
              color: network === 'testnet' ? colors.warning : colors.inkSoft,
              fontSize: 13,
              lineHeight: 19,
              marginTop: 6,
            }}
          >
            {network === 'testnet'
              ? 'This will be a testnet wallet — test coins only.'
              : 'This will be a mainnet wallet — real bitcoin.'}
          </Text>
        )}
        {resolved.map(({ index, slot, key }) => {
          const label = slotLabels(slot, index);
          return (
            <Row
              key={index}
              icon={label.icon}
              title={label.title}
              subtitle={key ? key.name : 'Missing — this key is no longer on the phone'}
            />
          );
        })}
      </Card>

      <Button title="Create wallet" large onPress={create} loading={saving} disabled={!ready || !name.trim()} />
      {ready && !name.trim() && (
        <Text style={{ color: colors.inkSoft, textAlign: 'center', fontSize: 13, lineHeight: 19 }}>
          Give the wallet a name first. You can change it later from Manage.
        </Text>
      )}
      {!ready && (
        <Text style={{ color: colors.inkSoft, textAlign: 'center', fontSize: 13, lineHeight: 19 }}>
          Some keys are missing or cannot go together. Go back to the Keys step.
        </Text>
      )}
    </>
  );
}

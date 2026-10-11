import React from 'react';
import { Alert, Text, View } from 'react-native';
import { Button, Card, Tag } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { extraStatus, ItemStatus, markSkipped, startSetup, unmark } from '../../lib/tutorial';
import { MultisigWallet } from '../../lib/types';
import { NoticeCard, StepProps } from './common';

export const VERIFY_EXPLAINER =
  'A backup you have never opened is a hope, not a backup. Bring the one you just made back in — the app compares it with this wallet and tells you if anything differs. Nothing is imported.';

/** Where the backup check stands. Shared with the checklist's "verify" item. */
export function VerifyStatusNotice({
  status,
  wallet,
}: {
  status: ItemStatus;
  wallet: Pick<MultisigWallet, 'backupVerifiedAt'>;
}) {
  if (status === 'done') {
    const date = wallet.backupVerifiedAt ? new Date(wallet.backupVerifiedAt).toLocaleString() : '';
    return <NoticeCard tone="success" title="Backup verified" lines={[`Checked ${date}.`]} />;
  }
  if (status === 'stale') {
    return (
      <NoticeCard
        tone="warning"
        title="A newer backup was made after the check"
        lines={['Check the newer copy, or keep only the copy you checked.']}
      />
    );
  }
  if (status === 'skipped') {
    return (
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        <Tag text="Skipped" tone="warning" />
      </View>
    );
  }
  return null;
}

/** The confirm dialog before the check is skipped. Shared with the checklist. */
export function confirmSkipVerify(onSkip: () => void): void {
  Alert.alert(
    'Skip checking the backup?',
    "A backup you have never opened is a hope, not a backup. You can check it later from the wallet's Manage screen.",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Skip', style: 'destructive', onPress: onSkip },
    ]
  );
}

/**
 * Step 5 · Check backup (recommended). Hands off to the VerifyBackup route,
 * which stamps backupVerifiedAt on a match; the step reads that back.
 */
export default function VerifyStep({ wallet, go, navigation }: StepProps) {
  const { keys, updateWallet } = useStore();

  if (!wallet) return null;
  const setup = wallet.setup ?? startSetup(undefined, wallet.createdAt);
  const status = extraStatus(wallet, 'verify', keys);

  const skip = () =>
    confirmSkipVerify(() => {
      // Re-stamp so a skip made against an older backup does not count for this one.
      updateWallet(wallet.id, { setup: markSkipped(unmark(setup, 'verify'), 'verify', Date.now()) }).catch((e) =>
        showError('tutorial:verify', e)
      );
    });

  return (
    <>
      <Card>
        <Text style={{ color: colors.inkSoft, fontSize: 14, lineHeight: 20 }}>{VERIFY_EXPLAINER}</Text>
      </Card>

      <VerifyStatusNotice status={status} wallet={wallet} />

      <Button
        title="Check my backup"
        icon="shield-checkmark-outline"
        large
        onPress={() => navigation.navigate('VerifyBackup', { walletId: wallet.id })}
      />
      {(status === 'todo' || status === 'stale') && (
        <Button title="Skip for now" variant="ghost" onPress={skip} />
      )}

      <Button
        title="Continue"
        large
        disabled={!['done', 'skipped'].includes(status)}
        onPress={() => go('checklist')}
      />
    </>
  );
}

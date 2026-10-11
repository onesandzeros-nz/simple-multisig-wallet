import React from 'react';
import { Text, View } from 'react-native';
import { Button, Card } from '../../components/ui';
import { colors } from '../../theme';
import { showError } from '../../lib/errors';
import { useStore } from '../../lib/store';
import { exportBackup } from '../../lib/exportActions';
import { backupStatus, confirmBackupStored, recordExport, startSetup } from '../../lib/tutorial';
import { WalletSetup } from '../../lib/types';
import { CheckRow, NoticeCard, StepProps } from './common';

/**
 * Step 4 · Back up (required). A file or PDF export plus the user's word
 * that the copy is stored away from this phone; neither alone passes the
 * step, and the tick cannot be given before an export exists.
 */
export default function BackupStep({ wallet, go }: StepProps) {
  const { updateWallet, groups, keys } = useStore();
  const [exporting, setExporting] = React.useState<'file' | 'pdf' | null>(null);

  if (!wallet) return null;
  // The guide attaches a checklist before this step is reachable; a wallet
  // that somehow has none adopts one on its first write here.
  const setup: WalletSetup = wallet.setup ?? startSetup(undefined, wallet.createdAt);

  const runExport = async (which: 'file' | 'pdf') => {
    setExporting(which);
    try {
      const withGroup = await exportBackup(which, wallet, groups, keys);
      // Only count it once the share sheet has been through successfully.
      await updateWallet(wallet.id, recordExport(wallet, which, Date.now(), withGroup));
    } catch (e: any) {
      showError(`wallet:export-${which}`, e);
    } finally {
      setExporting(null);
    }
  };

  const toggleStored = () => {
    let next: WalletSetup;
    if (setup.backupConfirmedAt) {
      // Un-tick: drop the stamp rather than store an undefined.
      const { backupConfirmedAt: _drop, ...rest } = setup;
      next = rest;
    } else {
      next = confirmBackupStored(setup, wallet, Date.now());
      if (next === setup) return; // no export yet — nothing to confirm
    }
    updateWallet(wallet.id, { setup: next }).catch((e) => showError('tutorial:backup', e));
  };

  return (
    <>
      <NoticeCard
        tone="warning"
        title="Back up this wallet"
        lines={[
          "Your keys alone cannot rebuild a multisig wallet — you also need every cosigner's public key. The backup holds public keys only and cannot spend your funds.",
          'File: a text file Sparrow, Coldcard and Specter accept. PDF: a page of QR codes this app scans back in. Sending the wallet to a Coldcard over NFC is not a backup — it lives on a signer.',
        ]}
      >
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Save file"
              icon="document-text-outline"
              onPress={() => runExport('file')}
              loading={exporting === 'file'}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Print QR PDF"
              icon="print-outline"
              variant="secondary"
              onPress={() => runExport('pdf')}
              loading={exporting === 'pdf'}
            />
          </View>
        </View>
      </NoticeCard>

      <Card>
        <Text
          style={{
            color: wallet.exportedAt ? colors.success : colors.inkSoft,
            fontSize: 13,
            lineHeight: 19,
            fontWeight: '600',
          }}
        >
          {wallet.exportedAt ? `Backed up ${new Date(wallet.exportedAt).toLocaleString()}` : 'Not backed up yet'}
        </Text>
        <CheckRow
          label="I have put this backup somewhere safe, away from this phone"
          disabled={!wallet.exportedAt}
          checked={!!setup.backupConfirmedAt}
          onPress={toggleStored}
        />
      </Card>

      <Button title="Continue" large disabled={backupStatus(wallet) !== 'done'} onPress={() => go('verify')} />
    </>
  );
}

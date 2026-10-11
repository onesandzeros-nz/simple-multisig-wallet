import React from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Button, SectionTitle, Tag, Row, Divider } from './ui';
import { colors } from '../theme';
import { keyCheckCode } from '../lib/bitcoin';
import { shortNpub } from '../lib/nostr/identity';
import { Group, SignerKey } from '../lib/types';
import { splitKeyCandidates } from '../lib/keyCandidates';

/**
 * One entry in the key list: a key already contributed to the group, or one
 * of this phone's keys not yet contributed. Ticking it adds the key to the
 * wallet; unticking removes it.
 */
export interface KeyCandidate {
  /** Stable React key. */
  key: string;
  name: string;
  fingerprint: string;
  /** The account xpub, known once the key has been contributed. */
  xpub: string | null;
  /** Author's group pubkey, for keys from other members. */
  author: string | null;
  mine: boolean;
  contributed: boolean;
  /**
   * The key record on this phone, for one of ours not yet contributed — what
   * ticking it publishes. Never set on a contributed key: a fingerprint match
   * is not proof a key is ours, and nothing must act on one.
   */
  local?: SignerKey;
  /** Whether it is currently in the wallet (the coordinator's selection). */
  inWallet: boolean;
}

/**
 * The coordinator's full-screen key setup: every key, ticked in or out of the
 * wallet, in two lists — other members' keys first, this phone's keys below.
 * Members never see it; they choose which keys to share when they join.
 */
export function ConfigureKeysModal({
  visible,
  onClose,
  group,
  candidates,
  chosenCount,
  onToggle,
}: {
  visible: boolean;
  onClose: () => void;
  group: Group;
  candidates: KeyCandidate[];
  chosenCount: number;
  onToggle: (candidate: KeyCandidate) => void;
}) {
  const { remote, local } = splitKeyCandidates(candidates);

  const renderKey = (c: KeyCandidate, i: number) => {
    const checked = c.inWallet;
    const atLimit = !checked && chosenCount >= group.n;
    const canToggle = checked || chosenCount < group.n;
    return (
      <View key={c.key}>
        {i > 0 && <Divider />}
        <Row
          icon={checked ? 'checkmark-circle' : 'ellipse-outline'}
          title={c.name}
          subtitle={`${c.xpub ? `check ${keyCheckCode(c.xpub)}` : c.fingerprint} · ${
            c.mine ? 'this phone' : shortNpub(c.author ?? '')
          }${atLimit ? ' · no places left' : ''}`}
          onPress={canToggle ? () => onToggle(c) : undefined}
          trailing={
            checked ? (
              <Tag text="In wallet" tone="success" />
            ) : c.mine ? (
              <Tag text="Mine" tone="accent" />
            ) : undefined
          }
        />
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 14,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          }}
        >
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink }}>Configure keys</Text>
          <Button title="Done" variant="secondary" compact onPress={onClose} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
          <SectionTitle>
            Keys · {chosenCount} of {group.n} in the wallet
          </SectionTitle>
          <Card>
            <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
              Tick a key to put it in the wallet, untick to take it out. Read each key's "check" code
              aloud to its owner to confirm it is really theirs before you accept it.
            </Text>
          </Card>

          <SectionTitle>From other members</SectionTitle>
          <Card>
            {remote.length === 0 && (
              <Text style={{ color: colors.inkSoft, fontSize: 14, paddingVertical: 4 }}>
                Nothing shared yet — other members' keys appear here as they share them.
              </Text>
            )}
            {remote.map(renderKey)}
          </Card>

          <SectionTitle>On this phone</SectionTitle>
          <Card>
            {local.length === 0 && (
              <Text style={{ color: colors.inkSoft, fontSize: 14, paddingVertical: 4 }}>
                No keys on this phone yet — add one in the Keys tab.
              </Text>
            )}
            {local.map(renderKey)}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

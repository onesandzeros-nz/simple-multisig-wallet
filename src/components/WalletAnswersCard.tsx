import React from 'react';
import { Text, View } from 'react-native';
import { Button, Card, SectionTitle, Tag, Row, Divider } from './ui';
import { colors } from '../theme';
import { shortNpub } from '../lib/nostr/identity';
import { MemberAnswer } from '../lib/nostr/walletAnswers';

/**
 * For the coordinator: who has added the shared wallet on their phone, who
 * declined it, and who has not answered yet. It matters while the wallet is
 * new, so it can be dismissed; a fresh build brings it back.
 */
export function WalletAnswersCard({
  walletName,
  answers,
  onDismiss,
}: {
  walletName: string;
  answers: MemberAnswer[];
  onDismiss?: () => void;
}) {
  const declined = answers.some((a) => a.answer === 'declined');
  return (
    <>
      <SectionTitle>Members' answers</SectionTitle>
      <Card>
        <Text style={{ color: colors.inkSoft, fontSize: 13, lineHeight: 19 }}>
          Who has added “{walletName}” on their phone.
          {declined
            ? ' Someone who declined does not agree with the keys in it — talk it over in the chat before anyone deposits.'
            : ''}
        </Text>
        {answers.length === 0 && (
          <Text style={{ color: colors.inkSoft, fontSize: 14, paddingVertical: 4 }}>
            No other members have joined yet.
          </Text>
        )}
        {answers.map((a, i) => (
          <View key={a.author}>
            {i > 0 && <Divider />}
            <Row
              icon={a.answer === 'added' ? 'checkmark-circle' : a.answer === 'declined' ? 'close-circle' : 'time-outline'}
              title={a.name}
              subtitle={shortNpub(a.author)}
              trailing={
                a.answer === 'added' ? (
                  <Tag text="Added" tone="success" />
                ) : a.answer === 'declined' ? (
                  <Tag text="Declined" tone="warning" />
                ) : (
                  <Tag text="No answer yet" />
                )
              }
            />
          </View>
        ))}
        {onDismiss && <Button title="Dismiss" icon="checkmark-outline" variant="ghost" onPress={onDismiss} />}
      </Card>
    </>
  );
}

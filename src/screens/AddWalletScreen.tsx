import React from 'react';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, Card, Row, Divider, SectionTitle } from '../components/ui';
import { IconName } from '../components/ui';
import { useStore } from '../lib/store';
import { draftProgress } from '../lib/tutorial';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'AddWallet'>;

interface Option {
  icon: IconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
}

export default function AddWalletScreen({ navigation }: Props) {
  const { setupDraft, keys } = useStore();
  // A guided setup in progress resumes from its next step.
  const progress = setupDraft ? draftProgress(setupDraft, keys) : null;
  const guided: Option = {
    icon: 'school-outline',
    title: 'Set up a private wallet step by step',
    subtitle: progress
      ? `Continue where you left off · ${progress.filled} of ${progress.total} keys added`
      : 'Guided: choose a policy, gather keys, back up, then check the backup',
    onPress: () => navigation.navigate('Tutorial'),
  };
  const options: Option[] = [
    {
      icon: 'construct-outline',
      title: 'Create a private wallet',
      onPress: () => navigation.navigate('CreateWallet'),
    },
    {
      icon: 'download-outline',
      title: 'Import an existing private wallet',
      onPress: () => navigation.navigate('ImportWallet'),
    },
    {
      icon: 'people-outline',
      title: 'Create a new group wallet',
      onPress: () => navigation.navigate('JoinGroup', { mode: 'create' }),
    },
    {
      icon: 'enter-outline',
      title: 'Join a group wallet',
      onPress: () => navigation.navigate('JoinGroup', { mode: 'join' }),
    },
  ];

  return (
    <Screen>
      <Card>
        <Row icon={guided.icon} title={guided.title} subtitle={guided.subtitle} onPress={guided.onPress} />
      </Card>

      <SectionTitle>I know what I want</SectionTitle>
      <Card>
        {options.map((o, i) => (
          <React.Fragment key={o.title}>
            {i > 0 && <Divider />}
            <Row icon={o.icon} title={o.title} subtitle={o.subtitle} onPress={o.onPress} />
          </React.Fragment>
        ))}
      </Card>

      <Card>
        <Row
          icon="help-circle-outline"
          title="Not sure what to do?"
          subtitle="See how these options differ"
          onPress={() => navigation.navigate('WalletHelp')}
        />
      </Card>
    </Screen>
  );
}

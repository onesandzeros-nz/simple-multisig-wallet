import React from 'react';
import { TouchableOpacity } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, EmptyState } from '../components/ui';
import { colors } from '../theme';
import { useStore } from '../lib/store';
import {
  STEP_ORDER,
  TutorialStep,
  backupStatus,
  draftNextStep,
  extraStatus,
  keysStepDone,
  stepTitle,
  walletNextStep,
} from '../lib/tutorial';
import { RootStackParamList } from '../navigation';
import { StepProgress, StepProps } from './tutorial/common';
import WelcomeStep from './tutorial/WelcomeStep';
import PolicyStep from './tutorial/PolicyStep';
import KeysStep from './tutorial/KeysStep';
import CreateStep from './tutorial/CreateStep';
import BackupStep from './tutorial/BackupStep';
import VerifyStep from './tutorial/VerifyStep';
import ChecklistStep from './tutorial/ChecklistStep';

type Props = NativeStackScreenProps<RootStackParamList, 'Tutorial'>;

/**
 * The guided private-wallet setup: one route that keeps the current step in
 * component state (the SendScreen pattern). Before the wallet exists the
 * steps work on the store's SetupDraft; afterwards on wallet.setup. Every
 * completed action is persisted, so leaving the route loses nothing and the
 * guide resumes at the next unfinished step.
 */
export default function TutorialScreen({ navigation, route }: Props) {
  const { wallets, keys, settings, setupDraft } = useStore();
  const wallet = route.params?.walletId ? wallets.find((w) => w.id === route.params!.walletId) : undefined;
  const [step, setStep] = React.useState<TutorialStep>(() =>
    wallet ? walletNextStep(wallet, keys) : setupDraft ? draftNextStep(setupDraft, keys, settings.testnet) : 'welcome'
  );
  // Once a wallet exists the pre-wallet steps are behind us for good.
  const firstStep: TutorialStep = wallet ? 'backup' : 'welcome';

  // Stepping back within the guide, rather than straight out of it.
  const goBack = React.useCallback(() => {
    const i = STEP_ORDER.indexOf(step);
    if (i <= STEP_ORDER.indexOf(firstStep)) navigation.goBack();
    else setStep(STEP_ORDER[i - 1]);
  }, [navigation, firstStep, step]);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: stepTitle(step),
      headerLeft: () => (
        <TouchableOpacity onPress={goBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.ink} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, step, goBack]);

  const done = new Set<TutorialStep>();
  if (setupDraft || wallet) done.add('policy');
  if (wallet || (setupDraft && keysStepDone(setupDraft, keys, settings.testnet))) done.add('keys');
  if (wallet) {
    done.add('create');
    if (backupStatus(wallet) === 'done') done.add('backup');
    const verify = extraStatus(wallet, 'verify', keys);
    if (verify === 'done' || verify === 'skipped') done.add('verify');
    if (wallet.setup?.completedAt) done.add('checklist');
  }

  const needsDraft = step === 'keys' || (step === 'create' && !wallet);
  const needsWallet = step === 'backup' || step === 'verify' || step === 'checklist';
  const nothingHere = (needsDraft && !setupDraft) || (needsWallet && !wallet);

  const stepProps: StepProps = { draft: setupDraft, wallet, go: setStep, navigation };
  const body = nothingHere ? (
    <Card>
      <EmptyState icon="compass-outline" text="Nothing to continue here. Start a guided setup from Wallets → + ." />
    </Card>
  ) : step === 'welcome' ? (
    <WelcomeStep {...stepProps} />
  ) : step === 'policy' ? (
    <PolicyStep {...stepProps} />
  ) : step === 'keys' ? (
    <KeysStep {...stepProps} />
  ) : step === 'create' ? (
    <CreateStep {...stepProps} />
  ) : step === 'backup' ? (
    <BackupStep {...stepProps} />
  ) : step === 'verify' ? (
    <VerifyStep {...stepProps} />
  ) : (
    <ChecklistStep {...stepProps} />
  );

  return (
    <Screen>
      <StepProgress current={step} done={done} />
      {body}
    </Screen>
  );
}

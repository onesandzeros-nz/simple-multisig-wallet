import type { AlertButton } from 'react-native';

/**
 * How a React Native alert maps onto a desktop message box: the labels in
 * the order given, which one Esc means, and which one Enter means. Kept
 * free of platform imports so it can be unit tested.
 *
 * Enter goes to the last button that is not the cancel — the "do it" one —
 * unless a button is marked destructive, in which case Enter is the cancel
 * (when there is one): a wallet should not delete a key on a reflex.
 */
export interface AlertPlan {
  labels: string[];
  cancelId: number | undefined;
  defaultId: number;
  destructive: boolean;
}

export function planAlert(buttons: readonly AlertButton[]): AlertPlan {
  const list: readonly AlertButton[] = buttons.length ? buttons : [{ text: 'OK' }];
  const labels = list.map((b, i) => (b.text && b.text.trim()) || (list.length === 1 ? 'OK' : `Button ${i + 1}`));
  const cancelIndex = list.findIndex((b) => b.style === 'cancel');
  const destructive = list.some((b) => b.style === 'destructive');
  let defaultId = labels.length - 1;
  while (defaultId > 0 && defaultId === cancelIndex) defaultId -= 1;
  if (destructive && cancelIndex >= 0) defaultId = cancelIndex;
  return {
    labels,
    cancelId: cancelIndex >= 0 ? cancelIndex : undefined,
    defaultId,
    destructive,
  };
}

import { Alert } from 'react-native';

/**
 * Show a friendly alert AND dump the full error to the console, so it
 * appears in Metro / adb logcat with a stack trace for debugging.
 */
export function showError(context: string, e: unknown, title = 'Hmm, that didn’t work'): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[${context}] ${err.constructor?.name}: ${err.message}\n${err.stack ?? '(no stack)'}`);
  // Some libraries throw typed errors with empty messages — never show a
  // blank alert; fall back to the error's class name.
  const body =
    err.message?.trim() ||
    (err.constructor?.name && err.constructor.name !== 'Error'
      ? `${err.constructor.name} (no details given)`
      : 'No details were given. The console log has more.');
  Alert.alert(title, body);
}

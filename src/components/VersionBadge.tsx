import React from 'react';
import { Text } from 'react-native';
import { colors } from '../theme';
import { APP_VERSION } from '../version';

/** Small "v1.2.3" for a header corner. */
export function VersionBadge() {
  return (
    <Text style={{ color: colors.inkFaint, fontSize: 13, fontVariant: ['tabular-nums'] }}>
      v{APP_VERSION}
    </Text>
  );
}

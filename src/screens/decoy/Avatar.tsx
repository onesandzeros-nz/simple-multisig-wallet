import React from 'react';
import { Text, View } from 'react-native';
import { initials } from '../../lib/decoy/data';

export function Avatar({ name, color, size = 48 }: { name: string; color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#FFFFFF', fontSize: size * 0.4, fontWeight: '600' }}>{initials(name)}</Text>
    </View>
  );
}

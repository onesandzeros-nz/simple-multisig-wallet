import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';

/** The brand orange of the middle box — fixed, it is not a theme colour. */
export const LOGO_ACCENT = '#FF6D00';

// Three message boxes, each cut with its own key teeth (assets/logo/mark.svg).
const TOP = 'M15 0 H145 V33 L140 44 H134 L127 30 H120 L113 44 H107 L102 38 H95 L90 44 H84 L78 34 H70 L64 44 H15 Z';
const MID = 'M55 62 H185 V106 H136 L129 96 H120 L113 106 H108 L102 90 H96 L90 106 H84 L78 99 H69 L63 106 H61 L55 95 Z';
const BOTTOM = 'M15 124 H145 V157 L140 168 H134 L127 158 H120 L113 168 H107 L102 152 H94 L89 168 H83 L77 162 H69 L63 168 H15 Z';

type Props = {
  /** Rendered height in px; the width follows the 200:180 mark. */
  size?: number;
  /** Outer boxes — defaults to the ink colour so it reads in both palettes. */
  color?: string;
};

/** The Simple Multi Sig mark. */
export function Logo({ size = 24, color }: Props) {
  const ink = color ?? colors.ink;
  return (
    <Svg width={(size * 200) / 180} height={size} viewBox="0 0 200 180">
      <Path d={TOP} fill={ink} />
      <Path d={MID} fill={LOGO_ACCENT} />
      <Path d={BOTTOM} fill={ink} />
    </Svg>
  );
}

/** Header title with the mark to its left; used on the tab screens. */
export function LogoHeaderTitle({ children }: { children?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Logo size={22} />
      <Text style={{ color: colors.ink, fontWeight: '600', fontSize: 17 }} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

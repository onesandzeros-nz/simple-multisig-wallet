// Minimal, professional design system: near-black ink on neutral
// surfaces, hairline borders, one restrained accent. No decoration.
// Two palettes; `colors` is mutated in place by applyTheme so every
// render reads the active palette.

const light = {
  bg: '#F6F7F9',
  card: '#FFFFFF',
  ink: '#15171A',
  inkSoft: '#6E7482',
  inkFaint: '#9AA0AB',
  line: '#E7E9ED',
  primary: '#15171A',
  onPrimary: '#FFFFFF',
  accent: '#2563EB',
  success: '#1F9D55',
  successBg: '#EAF6EF',
  warning: '#B45309',
  warningBg: '#FCF4EA',
  danger: '#DC2626',
  dangerBg: '#FCEDED',
  chipBg: '#EFF1F4',
  monoBg: '#F3F4F6',
};

const dark: typeof light = {
  bg: '#111215',
  card: '#1A1C21',
  ink: '#F0F1F3',
  inkSoft: '#9BA1AC',
  inkFaint: '#697077',
  line: '#2A2D34',
  primary: '#F0F1F3',
  onPrimary: '#15171A',
  accent: '#6D9BF5',
  success: '#3FBF77',
  successBg: '#172E22',
  warning: '#D9A05B',
  warningBg: '#31281A',
  danger: '#F07C7C',
  dangerBg: '#382124',
  chipBg: '#24272D',
  monoBg: '#1F2227',
};

export const colors = { ...light };

let activeTheme: 'light' | 'dark' = 'light';

export function applyTheme(darkMode: boolean): void {
  activeTheme = darkMode ? 'dark' : 'light';
  Object.assign(colors, darkMode ? dark : light);
}

/** Changes when the palette changes — used to invalidate cached StyleSheets. */
export function themeKey(): string {
  return activeTheme;
}

export const radius = {
  card: 16,
  control: 12,
  chip: 8,
};

export const shadow = {
  shadowColor: '#101828',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.05,
  shadowRadius: 3,
  elevation: 1,
};

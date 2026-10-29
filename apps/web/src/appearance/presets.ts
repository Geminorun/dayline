import { tr } from '../i18n/index';
export type ColorMode = 'light' | 'dark';
export type AppearanceMode = ColorMode | 'system';
export interface Palette {
  canvas: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
}
function palette(
  canvas: string,
  surface: string,
  ink: string,
  muted: string,
  line: string,
  accent: string,
): Palette {
  return { canvas, surface, ink, muted, line, accent };
}
export const themePresets = [
  {
    id: 'dayline',
    get name() {
      return tr('common.daylineGreen');
    },
    get description() {
      return tr('common.familiarPaperWhiteAndGreen');
    },
    light: palette(
      '#f6f7f4',
      '#ffffff',
      '#26352d',
      '#637268',
      '#dfe5de',
      '#315c4d',
    ),
    dark: palette(
      '#111a16',
      '#19241e',
      '#e5ede7',
      '#9eb0a4',
      '#34443b',
      '#82b99a',
    ),
  },
  {
    id: 'github',
    name: 'GitHub',
    get description() {
      return tr('presets.crispClearBlueAccents');
    },
    light: palette(
      '#f6f8fa',
      '#ffffff',
      '#1f2328',
      '#59636e',
      '#d1d9e0',
      '#0969da',
    ),
    dark: palette(
      '#0d1117',
      '#161b22',
      '#f0f6fc',
      '#9198a1',
      '#30363d',
      '#4493f8',
    ),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    get description() {
      return tr('common.neutralGrayAndClassicBlue');
    },
    light: palette(
      '#f3f3f3',
      '#ffffff',
      '#1f1f1f',
      '#616161',
      '#d4d4d4',
      '#005fb8',
    ),
    dark: palette(
      '#1e1e1e',
      '#252526',
      '#d4d4d4',
      '#a0a0a0',
      '#3c3c3c',
      '#3794ff',
    ),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    get description() {
      return tr('presets.lowSaturationSoftWhiteAndGraphite');
    },
    light: palette(
      '#f7f7f5',
      '#ffffff',
      '#262624',
      '#666660',
      '#deded8',
      '#58584f',
    ),
    dark: palette(
      '#141414',
      '#1b1b1b',
      '#e6e6df',
      '#aaaa9f',
      '#343432',
      '#bdbbb0',
    ),
  },
  {
    id: 'notion',
    name: 'Notion',
    get description() {
      return tr('common.quietPaperAndInk');
    },
    light: palette(
      '#f7f7f5',
      '#ffffff',
      '#37352f',
      '#68665f',
      '#e4e3df',
      '#37352f',
    ),
    dark: palette(
      '#191919',
      '#202020',
      '#e6e5e1',
      '#a5a49d',
      '#383835',
      '#d6d3c9',
    ),
  },
  {
    id: 'eyecare',
    get name() {
      return tr('common.eyeProtection');
    },
    get description() {
      return tr('presets.softLightGreenDesaturatedBackground');
    },
    light: palette(
      '#e8f0e3',
      '#f2f6ee',
      '#2d3b2c',
      '#586b55',
      '#c9d7c3',
      '#48743e',
    ),
    dark: palette(
      '#142014',
      '#1d2b1d',
      '#dfeadb',
      '#a1b69b',
      '#364a32',
      '#9fc58f',
    ),
  },
  {
    id: 'beige',
    get name() {
      return tr('common.beige');
    },
    get description() {
      return tr('presets.warmRicePaperWithBrownAccents');
    },
    light: palette(
      '#f6eedd',
      '#fff9ec',
      '#443a2e',
      '#756752',
      '#dcceb7',
      '#8a5a2b',
    ),
    dark: palette(
      '#251f18',
      '#30281f',
      '#ede3d0',
      '#bba98c',
      '#504231',
      '#d7ac70',
    ),
  },
] as const;
export type ThemeId = (typeof themePresets)[number]['id'];

export function normalizeHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(hex)) return hex;
  return /^#[\da-f]{3}$/.test(hex)
    ? '#' + [...hex.slice(1)].map((digit) => digit + digit).join('')
    : null;
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
export function mixColor(a: string, b: string, weight: number): string {
  const right = rgb(b);
  return (
    '#' +
    rgb(a)
      .map((value, index) =>
        Math.round(value * (1 - weight) + (right[index] ?? 0) * weight)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function luminance(hex: string): number {
  const linear = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    (linear[0] ?? 0) * 0.2126 +
    (linear[1] ?? 0) * 0.7152 +
    (linear[2] ?? 0) * 0.0722
  );
}
export function contrastRatio(a: string, b: string): number {
  const left = luminance(a),
    right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
export function readableAccent(
  accent: string,
  surface: string,
  ink: string,
): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(accent, ink, step / 20);
    if (contrastRatio(candidate, surface) >= 4.5) return candidate;
  }
  return ink;
}

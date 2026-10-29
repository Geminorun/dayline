import { computed, reactive, ref } from 'vue';
import {
  themePalettes,
  mixColor,
  contrastRatio,
  readableAccent,
  normalizeHex,
} from '@dayline/core';
import type { AppearanceMode, ColorMode, ThemeId } from '@dayline/core';
import { tr } from '../i18n';
const storageKey = 'dayline:mini:appearance:v1';
const preferences = reactive<{
  theme: ThemeId;
  mode: AppearanceMode;
  accent: string | null;
}>({
  theme: 'dayline',
  mode: 'system',
  accent: null,
});
const systemDark = ref(false),
  storageError = ref('');
export const themePresets = themePalettes.map((item) => ({
  ...item,
  get name() {
    return 'nameKey' in item ? tr(item.nameKey) : item.name;
  },
}));
const resolvedMode = computed<ColorMode>(() =>
  preferences.mode === 'system'
    ? systemDark.value
      ? 'dark'
      : 'light'
    : preferences.mode,
);
const palette = computed(
  () =>
    (themePalettes.find((p) => p.id === preferences.theme) ?? themePalettes[0])[
      resolvedMode.value
    ],
);
const tokens = computed(() => {
  const p = {
      ...palette.value,
      accent: preferences.accent ?? palette.value.accent,
    },
    dark = resolvedMode.value === 'dark';
  return {
    canvas: p.canvas,
    surface: p.surface,
    ink: p.ink,
    muted: p.muted,
    line: p.line,
    accent: p.accent,
    'accent-ink': readableAccent(p.accent, p.surface, p.ink),
    'accent-soft': mixColor(p.surface, p.accent, dark ? 0.18 : 0.09),
    'surface-subtle': mixColor(p.surface, p.canvas, 0.7),
    'on-accent':
      contrastRatio(p.accent, '#fffFFF') >= contrastRatio(p.accent, '#000000')
        ? '#ffffff'
        : '#000000',
    danger: dark ? '#ff938a' : '#b42318',
    warning: dark ? '#f2cc60' : '#9a6700',
    overlay: dark ? '#00000099' : '#26352d66',
  };
});
const themeStyle = computed(() =>
  Object.entries(tokens.value)
    .map(([key, value]) => `--${key}:${value}`)
    .join(';'),
);
function applyNativeTheme() {
  const p = palette.value;
  if (typeof uni === 'undefined') return;
  if (typeof getCurrentPages === 'function' && !getCurrentPages().length)
    return;
  uni.setNavigationBarColor?.({
    frontColor: resolvedMode.value === 'dark' ? '#ffffff' : '#000000',
    backgroundColor: p.canvas,
    animation: { duration: 0, timingFunc: 'linear' },
  });
  uni.setBackgroundColor?.({
    backgroundColor: p.canvas,
    backgroundColorTop: p.canvas,
    backgroundColorBottom: p.canvas,
  });
  uni.setTabBarStyle?.({
    color: p.muted,
    selectedColor: tokens.value['accent-ink'],
    backgroundColor: p.surface,
    borderStyle: resolvedMode.value === 'dark' ? 'black' : 'white',
  });
}
function persist() {
  applyNativeTheme();
  try {
    uni.setStorageSync(storageKey, { ...preferences });
    storageError.value = '';
  } catch {
    storageError.value = '外观已应用，但未能保存到本机。';
  }
}
function setTheme(value: string) {
  const found = themePalettes.find((p) => p.id === value);
  if (found) {
    preferences.theme = found.id;
    preferences.accent = null;
    persist();
  }
}
function setAccent(value: string | null) {
  const next = value === null ? null : normalizeHex(value);
  if (value !== null && !next) return false;
  preferences.accent = next;
  persist();
  return true;
}
function setMode(value: AppearanceMode) {
  preferences.mode = value;
  persist();
}
let listening = false;
export function initializeAppearance() {
  preferences.theme = 'dayline';
  preferences.mode = 'system';
  preferences.accent = null;
  try {
    const saved: unknown = uni.getStorageSync(storageKey);
    if (saved && typeof saved === 'object') {
      if ('accent' in saved && typeof saved.accent === 'string')
        preferences.accent = normalizeHex(saved.accent);
      if ('theme' in saved) {
        const found = themePalettes.find((p) => p.id === saved.theme);
        if (found) preferences.theme = found.id;
      }
      if (
        'mode' in saved &&
        (saved.mode === 'system' ||
          saved.mode === 'dark' ||
          saved.mode === 'light')
      )
        preferences.mode = saved.mode;
    }
    systemDark.value = uni.getSystemInfoSync?.().theme === 'dark';
  } catch {
    /* Use the default theme when storage is unavailable. */
  }
  if (!listening && typeof uni.onThemeChange === 'function') {
    uni.onThemeChange((e) => {
      systemDark.value = e.theme === 'dark';
      applyNativeTheme();
    });
    listening = true;
  }
  applyNativeTheme();
}
export function useAppearance() {
  return {
    preferences,
    palette,
    resolvedMode,
    themeStyle,
    tokens,
    storageError,
    setTheme,
    setMode,
    setAccent,
    applyNativeTheme,
  };
}

import { themePalettes } from '@dayline/core';
import { messageRef } from '../i18n/index';
import { msg } from '@dayline/locales';
import { computed, reactive, readonly, ref } from 'vue';
import {
  mixColor,
  normalizeHex,
  contrastRatio,
  readableAccent,
  themePresets,
} from './presets';
import type { AppearanceMode, ColorMode, ThemeId } from './presets';

export const appearanceStorageKey = 'dayline:appearance:v1';
interface AppearancePreferences {
  theme: ThemeId;
  mode: AppearanceMode;
  accent: string | null;
}
const defaults: AppearancePreferences = {
  theme: 'dayline',
  mode: 'light',
  accent: null,
};
const preferences = reactive<AppearancePreferences>({ ...defaults });
const systemDark = ref(false),
  storageError = messageRef();
const resolvedMode = computed<ColorMode>(() =>
  preferences.mode === 'system'
    ? systemDark.value
      ? 'dark'
      : 'light'
    : preferences.mode,
);
const preset = computed(
  () =>
    themePresets.find((item) => item.id === preferences.theme) ??
    themePresets[0] ??
    themePalettes[0],
);
const palette = computed(() => preset.value[resolvedMode.value]);
const accent = computed(() => preferences.accent ?? palette.value.accent);
let media: MediaQueryList | undefined;
let listening = false;

function parsePreferences(raw: string | null): AppearancePreferences {
  if (!raw) return { ...defaults };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ...defaults };
    const theme =
      'theme' in value
        ? themePresets.find((item) => item.id === value.theme)?.id
        : undefined;
    const mode =
      'mode' in value &&
      ['light', 'dark', 'system'].includes(String(value.mode))
        ? value.mode
        : defaults.mode;
    return {
      theme: theme ?? defaults.theme,
      mode: mode === 'dark' || mode === 'system' ? mode : 'light',
      accent:
        'accent' in value && typeof value.accent === 'string'
          ? normalizeHex(value.accent)
          : null,
    };
  } catch {
    return { ...defaults };
  }
}
function apply() {
  const value = palette.value,
    color = accent.value,
    dark = resolvedMode.value === 'dark';
  const accentInk = readableAccent(color, value.surface, value.ink);
  const variables: Record<string, string> = {
    canvas: value.canvas,
    surface: value.surface,
    'surface-subtle': mixColor(value.surface, value.canvas, 0.65),
    'surface-raised': mixColor(value.surface, value.ink, dark ? 0.035 : 0),
    ink: value.ink,
    'ink-soft': mixColor(value.ink, value.muted, 0.5),
    muted: value.muted,
    line: value.line,
    accent: color,
    'accent-ink': accentInk,
    'accent-hover': mixColor(
      color,
      contrastRatio(color, '#ffffff') > contrastRatio(color, '#000000')
        ? '#000000'
        : '#ffffff',
      0.12,
    ),
    'accent-soft': mixColor(value.surface, color, dark ? 0.18 : 0.11),
    'on-accent':
      contrastRatio(color, '#ffffff') >= contrastRatio(color, '#000000')
        ? '#ffffff'
        : '#000000',
    focus: accentInk,
    danger: dark ? '#ff938a' : '#b42318',
    'danger-soft': dark ? '#3c2324' : '#fef3f2',
    'on-danger': dark ? '#000000' : '#ffffff',
    warning: dark ? '#f2cc60' : '#9a6700',
    'warning-soft': dark ? '#362d13' : '#fff8df',
    success: dark ? '#83d5a3' : '#337c52',
    'success-soft': dark ? '#183327' : '#edf7f0',
    shadow: dark ? '#00000055' : '#26352d14',
    overlay: dark ? '#00000099' : '#26352d66',
  };
  for (const [key, colorValue] of Object.entries(variables))
    document.documentElement.style.setProperty('--' + key, colorValue);
  document
    .querySelector('meta[name=theme-color]')
    ?.setAttribute('content', value.surface);
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.colorMode = resolvedMode.value;
  document.documentElement.style.colorScheme = resolvedMode.value;
}
function persist() {
  apply();
  try {
    localStorage.setItem(appearanceStorageKey, JSON.stringify(preferences));
    storageError.value = '';
  } catch {
    storageError.value = msg('theme.theCurrentSkinHasBeenAppliedBut');
  }
}
function systemChanged(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
  apply();
}
function storageChanged(event: StorageEvent) {
  if (event.key !== appearanceStorageKey && event.key !== null) return;
  Object.assign(
    preferences,
    parsePreferences(event.key === null ? null : event.newValue),
  );
  apply();
}
export function initializeAppearance() {
  if (listening) return;
  storageError.value = '';
  try {
    Object.assign(
      preferences,
      parsePreferences(localStorage.getItem(appearanceStorageKey)),
    );
  } catch {
    Object.assign(preferences, defaults);
  }
  media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined;
  systemDark.value = media?.matches ?? false;
  media?.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  listening = true;
  apply();
}
export function stopAppearance() {
  media?.removeEventListener('change', systemChanged);
  window.removeEventListener('storage', storageChanged);
  listening = false;
}
export function useAppearance() {
  return {
    preferences: readonly(preferences),
    palette,
    accent,
    resolvedMode,
    storageError: readonly(storageError),
    setTheme(theme: ThemeId) {
      preferences.theme = theme;
      preferences.accent = null;
      persist();
    },
    setMode(mode: AppearanceMode) {
      preferences.mode = mode;
      persist();
    },
    setAccent(value: string): boolean {
      const normalized = normalizeHex(value);
      if (!normalized) return false;
      preferences.accent = normalized;
      persist();
      return true;
    },
    resetAccent() {
      preferences.accent = null;
      persist();
    },
    reset() {
      Object.assign(preferences, defaults);
      persist();
    },
  };
}

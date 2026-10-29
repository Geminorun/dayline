import { afterEach, expect, it, vi } from 'vitest';
import {
  initializeAppearance,
  useAppearance,
  themePresets,
} from '../src/appearance/theme';
afterEach(() => vi.unstubAllGlobals());
it('shares palettes, persists a choice and applies it to native navigation and tab bar', () => {
  const storage = new Map<string, unknown>(),
    nav = vi.fn(),
    tabs = vi.fn();
  vi.stubGlobal('uni', {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    getSystemInfoSync: () => ({ theme: 'dark' }),
    setNavigationBarColor: nav,
    setTabBarStyle: tabs,
    setBackgroundColor: vi.fn(),
  });
  initializeAppearance();
  const a = useAppearance();
  expect(a.resolvedMode.value).toBe('dark');
  a.setTheme('beige');
  a.setMode('light');
  expect(a.themeStyle.value).toContain('--canvas:');
  expect(a.palette.value).toEqual(
    themePresets.find((p) => p.id === 'beige')?.light,
  );
  expect(tabs).toHaveBeenLastCalledWith(
    expect.objectContaining({ backgroundColor: a.palette.value.surface }),
  );
  expect(nav).toHaveBeenLastCalledWith(
    expect.objectContaining({ frontColor: '#000000' }),
  );
  initializeAppearance();
  expect(a.preferences.theme).toBe('beige');
  expect(a.resolvedMode.value).toBe('light');
});
it('keeps the selected skin usable if storage fails', () => {
  vi.stubGlobal('uni', {
    getStorageSync: () => null,
    setStorageSync: () => {
      throw new Error('full');
    },
  });
  initializeAppearance();
  const a = useAppearance();
  a.setTheme('eyecare');
  expect(a.preferences.theme).toBe('eyecare');
  expect(a.storageError.value).toContain('未能保存');
});

it('restores a custom accent without losing readable foreground colors', () => {
  const storage = new Map<string, unknown>();
  vi.stubGlobal('uni', {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
  });
  initializeAppearance();
  const a = useAppearance();
  a.setMode('light');
  expect(a.setAccent('#fff')).toBe(true);
  expect(a.tokens.value.accent).toBe('#ffffff');
  expect(a.tokens.value['on-accent']).toBe('#000000');
  initializeAppearance();
  expect(a.preferences.accent).toBe('#ffffff');
  expect(a.setAccent('invalid')).toBe(false);
  expect(a.preferences.accent).toBe('#ffffff');
});

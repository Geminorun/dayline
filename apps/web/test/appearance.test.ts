import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppearanceSettings from '../src/appearance/AppearanceSettings.vue';
import {
  appearanceStorageKey,
  initializeAppearance,
  stopAppearance,
  useAppearance,
} from '../src/appearance/theme';
import {
  contrastRatio,
  normalizeHex,
  readableAccent,
  themePresets,
} from '../src/appearance/presets';
const media = Object.assign(new EventTarget(), {
  matches: false,
  media: '(prefers-color-scheme: dark)',
});
beforeEach(() => {
  stopAppearance();
  localStorage.clear();
  media.matches = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  initializeAppearance();
});
afterEach(() => {
  stopAppearance();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('device appearance preferences', () => {
  it('preserves the current default and restores custom appearance after reinitialization', () => {
    const appearance = useAppearance();
    expect(appearance.preferences).toEqual({
      theme: 'dayline',
      mode: 'light',
      accent: null,
    });
    appearance.setTheme('beige');
    appearance.setMode('dark');
    appearance.setAccent('#ff0');
    stopAppearance();
    initializeAppearance();
    expect(appearance.preferences).toEqual({
      theme: 'beige',
      mode: 'dark',
      accent: '#ffff00',
    });
    expect(document.documentElement.dataset.colorMode).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe(
      '#000000',
    );
    expect(
      contrastRatio(
        document.documentElement.style.getPropertyValue('--accent-ink'),
        appearance.palette.value.surface,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('tracks system mode and cross-tab updates, ignoring unsafe or malformed values', () => {
    const appearance = useAppearance();
    appearance.setMode('system');
    media.matches = true;
    media.dispatchEvent(
      Object.assign(new Event('change'), { matches: true, media: media.media }),
    );
    expect(appearance.resolvedMode.value).toBe('dark');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: appearanceStorageKey,
        newValue: JSON.stringify({
          theme: 'eyecare',
          mode: 'light',
          accent: 'url(private)',
        }),
      }),
    );
    expect(appearance.preferences).toEqual({
      theme: 'eyecare',
      mode: 'light',
      accent: null,
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: appearanceStorageKey,
        newValue: 'not json',
      }),
    );
    expect(appearance.preferences.theme).toBe('dayline');
  });
  it('applies a choice despite unavailable storage and resets its complete palette', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const appearance = useAppearance();
    appearance.setTheme('cursor');
    expect(document.documentElement.dataset.theme).toBe('cursor');
    expect(appearance.storageError.value).toContain('无法保存');
    appearance.reset();
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe(
      '#f6f7f4',
    );
  });
  it('provides readable text and accent labels in every light/dark palette, including extreme custom colors', () => {
    expect(themePresets).toHaveLength(7);
    for (const theme of themePresets)
      for (const mode of ['light', 'dark'] as const) {
        const palette = theme[mode];
        expect(
          contrastRatio(palette.ink, palette.surface),
        ).toBeGreaterThanOrEqual(4.5);
        for (const accent of ['#ffffff', '#000000', '#ffff00', palette.accent])
          expect(
            contrastRatio(
              readableAccent(accent, palette.surface, palette.ink),
              palette.surface,
            ),
          ).toBeGreaterThanOrEqual(4.5);
      }
    expect(normalizeHex('var(--private)')).toBeNull();
  });
  it('makes themes and mode available as native radio controls and rejects invalid hex input', async () => {
    const wrapper = mount(AppearanceSettings);
    await wrapper.get('input[value="eyecare"]').setValue(true);
    expect(useAppearance().preferences.theme).toBe('eyecare');
    await wrapper.get('input[value="dark"]').setValue(true);
    expect(useAppearance().resolvedMode.value).toBe('dark');
    await wrapper.get('input[aria-label="主题色 HEX"]').setValue('#oops');
    expect(wrapper.get('[role="alert"]').text()).toContain('有效色值');
    wrapper.unmount();
  });
});

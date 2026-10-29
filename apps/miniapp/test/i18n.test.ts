import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import {
  changeLanguage,
  initializeLanguage,
  locale,
  tr,
  monthName,
} from '../src/i18n';
afterEach(async () => {
  changeLanguage('zh-CN', false);
  await nextTick();
  vi.unstubAllGlobals();
});
it('uses system language and local preference and translates native navigation and tabs', async () => {
  const platform = {
    getStorageSync: vi.fn(() => ''),
    getLocale: vi.fn(() => 'en-US'),
    setStorageSync: vi.fn(),
    setLocale: vi.fn(),
    setNavigationBarTitle: vi.fn(),
    setTabBarItem: vi.fn(),
  };
  vi.stubGlobal('uni', platform);
  vi.stubGlobal('getCurrentPages', () => [{ route: 'pages/timeline/index' }]);
  initializeLanguage();
  await nextTick();
  expect(locale.value).toBe('en');
  expect(platform.setNavigationBarTitle).toHaveBeenCalledWith({
    title: 'Timeline',
  });
  changeLanguage('zh-CN');
  await nextTick();
  expect(platform.setStorageSync).toHaveBeenCalledWith(
    'dayline:locale:v1',
    'zh-CN',
  );
  expect(platform.setTabBarItem).toHaveBeenCalled();
  expect(tr('common.save')).toBe('保存');
});
it('translates without Intl on older platform runtimes and provides a calendar fallback', async () => {
  vi.stubGlobal('uni', { setLocale: vi.fn(), setStorageSync: vi.fn() });
  vi.stubGlobal('Intl', undefined);
  changeLanguage('en', false);
  await nextTick();
  expect(tr('common.save')).toBe('Save');
  expect(monthName(2026, 10)).toBe('October');
});

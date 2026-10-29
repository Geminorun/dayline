import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { initializeLanguage, locale, tr, monthName } from '../src/i18n';
import { useWorkspace } from '../src/workspace';
afterEach(() => vi.unstubAllGlobals());
it('keeps native labels and requests Chinese regardless of device and account language', async () => {
  const platform = {
    getStorageSync: vi.fn(() => 'en'),
    getLocale: vi.fn(() => 'en-US'),
    setLocale: vi.fn(),
    setNavigationBarTitle: vi.fn(),
    setTabBarItem: vi.fn(),
    setStorageSync: vi.fn(),
  };
  vi.stubGlobal('uni', platform);
  vi.stubGlobal('getCurrentPages', () => [{ route: 'pages/timeline/index' }]);
  initializeLanguage();
  const w = useWorkspace();
  w.current.value = {
    id: 'language-owner',
    locale: 'en',
    displayName: 'Name',
    profileVersion: 1,
    email: null,
    emailVerified: false,
    passwordEnabled: false,
    wechatBound: true,
    status: 'active',
    deletionDueAt: null,
    timeZone: 'Asia/Shanghai',
  };
  await nextTick();
  expect(locale.value).toBe('zh-CN');
  expect(tr('common.save')).toBe('保存');
  expect(w.current.value.locale).toBe('en');
  expect(platform.setStorageSync).not.toHaveBeenCalled();
  expect(platform.setNavigationBarTitle).toHaveBeenCalledWith({
    title: '时间轴',
  });
  expect(platform.setTabBarItem).toHaveBeenCalledTimes(3);
  w.current.value = null;
});
it('does not need Intl for the Chinese calendar', () => {
  vi.stubGlobal('Intl', undefined);
  expect(monthName(2026, 10)).toBe('10月');
});

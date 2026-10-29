import 'fake-indexeddb/auto';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import { msg } from '@dayline/locales';
import AuthPage from '../src/AuthPage.vue';
import {
  changeLanguage,
  locale,
  messageRef,
  tr,
  formatBeijingTime,
  monthYearLabel,
} from '../src/i18n';
import { pluralParams, vueMessages } from '@dayline/locales/ui';
afterEach(() => {
  changeLanguage('zh-CN');
  vi.restoreAllMocks();
});
it('updates held notices and countdowns immediately without rewriting stored messages', () => {
  const notice = messageRef(msg('errors.internal'));
  expect(notice.value).toContain('服务暂时不可用');
  changeLanguage('en');
  expect(notice.value).toContain('temporarily unavailable');
  expect(locale.value).toBe('en');
  changeLanguage('zh-CN');
  expect(notice.value).toContain('服务暂时不可用');
});
it('uses English singular and plural forms through Vue I18n', () => {
  changeLanguage('en');
  const key = Object.keys(pluralParams).find((k) =>
    vueMessages.en[k]?.includes('seconds'),
  );
  if (!key) throw new Error('Missing countdown plural');
  const parameter = pluralParams[key];
  if (!parameter) throw new Error('Missing count argument');
  expect(tr(key, { [parameter]: 1 })).toMatch(/1 second\b/);
  expect(tr(key, { [parameter]: 2 })).toMatch(/2 seconds\b/);
});
it('renders every UI catalog key with its parameters in both languages', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    changeLanguage(language);
    for (const [key, template] of Object.entries(vueMessages[language])) {
      const params = Object.fromEntries(
        [...template.matchAll(/\{(\w+)\}/g)].map((match) => [match[1], 7]),
      );
      const text = tr(key, params);
      expect(text, `${language}/${key}`).not.toBe(key);
      expect(text, `${language}/${key}`).not.toContain('[object Object]');
    }
  }
});
it('switches the login form without losing entered credentials or remounting inputs', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:mode', component: AuthPage }],
  });
  await router.push('/login');
  await router.isReady();
  const w = mount(AuthPage, { global: { plugins: [router] } });
  try {
    await flushPromises();
    const email = w.get<HTMLInputElement>('input[name=email]'),
      password = w.get<HTMLInputElement>('input[name=password]');
    await email.setValue('language@example.com');
    await password.setValue('Never-persist-this-password!');
    const element = email.element;
    changeLanguage('en');
    await flushPromises();
    expect(w.text()).toContain('Sign in');
    expect(w.get<HTMLInputElement>('input[name=email]').element).toBe(element);
    expect(email.element.value).toBe('language@example.com');
    expect(password.element.value).toBe('Never-persist-this-password!');
    changeLanguage('zh-CN');
    await flushPromises();
    expect(w.text()).toContain('登录');
    expect(email.element.value).toBe('language@example.com');
  } finally {
    w.unmount();
  }
});
it('changes labels while preserving the Beijing business day and calendar year boundaries', () => {
  changeLanguage('en');
  expect(formatBeijingTime('2026-10-28T16:00:00.000Z')).toBe(
    '2026-10-29 00:00:00 (Beijing time)',
  );
  expect(monthYearLabel(1, 1)).toBe('January 1');
  changeLanguage('zh-CN');
  expect(formatBeijingTime('2026-10-28T16:00:00.000Z')).toContain(
    '2026-10-29 00:00:00',
  );
  expect(monthYearLabel(2026, 10)).toBe('2026年10月');
});

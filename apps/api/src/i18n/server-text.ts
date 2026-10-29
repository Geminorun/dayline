import { I18nContext } from 'nestjs-i18n';
import { formatMessage, normalizeLocale } from '@dayline/locales';
import type { Locale, UiText } from '@dayline/locales';
import { serverMessages } from '@dayline/locales/server';
import { requestBudget } from '../common/request-budget.js';
export function requestLocale(): Locale {
  return (
    requestBudget.getStore()?.locale ??
    normalizeLocale(I18nContext.current()?.lang)
  );
}
export function serverText(value: UiText, language?: Locale): string {
  if (typeof value === 'string') return value;
  const context = I18nContext.current();
  const lang = language ?? requestLocale();
  const fallback = formatMessage(value, lang, serverMessages[lang]);
  const translated: unknown = context?.t(value.key, {
    lang,
    args: { ...value.params },
    defaultValue: fallback,
  });
  return typeof translated === 'string' ? translated : fallback;
}

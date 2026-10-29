import {
  admissionStatusLabel as baseAdmissionStatusLabel,
  identityStatusLabel as baseIdentityStatusLabel,
} from '@dayline/contracts';
import {
  formatBeijingTime as baseBeijingTime,
  durationDays,
} from '@dayline/core';
import type { ViewEntry } from '@dayline/core';
import type { Ref } from 'vue';
import { computed, customRef, watch } from 'vue';
import { createI18n } from 'vue-i18n';
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  sharedMessages,
  isMessage,
} from '@dayline/locales';
import type { Locale, UiText } from '@dayline/locales';
import { vueMessages, pluralParams } from '@dayline/locales/ui';
const legacyKeys = new Map(
  Object.values(sharedMessages).flatMap((catalog) =>
    Object.entries(catalog).map(([key, text]) => [text, key]),
  ),
);
const storageKey = 'dayline:locale:v1';
export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  flatJson: true,
  missingWarn: false,
  fallbackWarn: false,
  warnHtmlMessage: false,
  messages: { 'zh-CN': { ...vueMessages['zh-CN'] }, en: { ...vueMessages.en } },
});
export const locale = i18n.global.locale;
export const languageChoices = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
] as const;
export function tr(key: string, params: Record<string, unknown> = {}): string {
  const values = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      isMessage(v) ? renderMessage(v) : (v ?? ''),
    ]),
  );
  return i18n.global.t(key, values, {
    plural:
      typeof params.count === 'number'
        ? params.count
        : Number(params[pluralParams[key] ?? '']) || 2,
  });
}
export function renderMessage(value: UiText): string {
  if (isMessage(value)) return tr(value.key, { ...value.params });
  const key = sharedMessages[locale.value][value]
    ? value
    : legacyKeys.get(value);
  return key ? tr(key) : value;
}
/** Keep descriptors in state while exposing translated text to existing views. */
type MessageRef = Omit<Ref<UiText>, 'value'> & {
  get value(): string;
  set value(value: UiText);
};
export function messageRef(initial: UiText = '') {
  let source = initial;
  return customRef<UiText>((track, trigger) => ({
    get() {
      track();
      return renderMessage(source);
    },
    set(value) {
      source = value;
      trigger();
    },
  })) as MessageRef;
}
let owner: string | null = null,
  previousPreference: Locale | null = null;
export function applyAccountLanguage(id: string, preferred: Locale) {
  if (id !== owner || preferred !== previousPreference)
    changeLanguage(preferred, false);
  owner = id;
  previousPreference = preferred;
}
export function clearAccountLanguage() {
  owner = null;
  previousPreference = null;
}
export const languageName = computed(
  () =>
    languageChoices.find((c) => c.value === locale.value)?.label ?? '简体中文',
);
export function changeLanguage(value: Locale, persist = true) {
  locale.value = normalizeLocale(value);
  document.documentElement.lang = locale.value;
  document.title = locale.value === 'en' ? 'Dayline' : '日序';
  if (persist)
    try {
      localStorage.setItem(storageKey, locale.value);
    } catch {
      return false;
    }
  return true;
}
export function initializeLanguage() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    /* Settings still work in memory. */
  }
  changeLanguage(
    normalizeLocale(saved ?? navigator.languages?.[0] ?? navigator.language),
    false,
  );
}
watch(locale, (value) => {
  document.documentElement.lang = value;
  document.title = value === 'en' ? 'Dayline' : '日序';
});

export function formatBeijingTime(value: string | null | undefined): string {
  if (!value) return tr('dates.notSet');
  if (!Number.isFinite(Date.parse(value))) return tr('dates.unavailable');
  return baseBeijingTime(value).replace('（北京时间）', tr('dates.beijing'));
}
export function spanLabel(entry: ViewEntry, today: string): string {
  return entry.startDate > today
    ? tr('dates.startsOn', { date: entry.startDate })
    : tr(entry.endDate ? 'dates.span' : 'dates.elapsed', {
        count: durationDays(entry, today),
      });
}
export function monthName(year: number, month: number): string {
  if (locale.value === 'zh-CN') return String(month) + '月';
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, 15);
  date.setUTCHours(4, 0, 0, 0);
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function')
    return new Intl.DateTimeFormat('en', {
      month: 'long',
      timeZone: 'Asia/Shanghai',
    }).format(date);
  return (
    [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ][month - 1] ?? String(month)
  );
}

export function monthYearLabel(year: number, month: number): string {
  return locale.value === 'en'
    ? monthName(year, month) + ' ' + year
    : year + '年' + month + '月';
}
export function calendarLabel(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return locale.value === 'en'
    ? monthName(year ?? 1, month ?? 1).slice(0, 3) + ' ' + day + ', ' + year
    : year + '年' + month + '月' + day + '日';
}
export function tickLabel(label: string): string {
  const match = /^(\d{1,2})月$/.exec(label);
  return match && locale.value === 'en'
    ? monthName(2026, Number(match[1])).slice(0, 3)
    : label;
}

export function admissionStatusLabel(
  status: Parameters<typeof baseAdmissionStatusLabel>[0],
): string {
  return renderMessage(baseAdmissionStatusLabel(status));
}
export function identityStatusLabel(status: string): string {
  return renderMessage(baseIdentityStatusLabel(status));
}

export { errorMessageKeys } from './error-codes.js';
import format from 'string-format';
import { sharedMessages } from './shared/index.js';
export { sharedMessages } from './shared/index.js';
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export function normalizeLocale(value: unknown): Locale {
  return typeof value === 'string' && /^en(?:-|$)/i.test(value)
    ? 'en'
    : DEFAULT_LOCALE;
}
export interface Message {
  readonly kind: 'i18n';
  readonly key: string;
  readonly params: Readonly<Record<string, unknown>>;
}
export type UiText = string | Message;
export function msg(
  key: string,
  params: Record<string, unknown> = {},
): Message {
  return { kind: 'i18n', key, params };
}
export function isMessage(value: unknown): value is Message {
  return (
    !!value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'i18n' &&
    'key' in value &&
    typeof value.key === 'string' &&
    'params' in value &&
    !!value.params &&
    typeof value.params === 'object'
  );
}
export interface LocalizedFailure {
  readonly localized?: Message;
}
const diagnosticKeys = new Map(
  Object.entries(sharedMessages).flatMap(([, catalog]) =>
    Object.entries(catalog).map(([key, text]) => [text, key] as const),
  ),
);
/** Compatibility for stored diagnostics; never apply this to user record content. */
export function diagnosticMessage(value: UiText): UiText {
  if (typeof value !== 'string') return value;
  const key = sharedMessages['zh-CN'][value]
    ? value
    : diagnosticKeys.get(value);
  return key ? msg(key) : value;
}
/** Deterministic diagnostic text; presentation uses the structured descriptor. */
export function fallbackText(value: UiText): string {
  return formatMessage(value, DEFAULT_LOCALE);
}
export function formatMessage(
  value: UiText,
  locale: Locale,
  resources: Record<string, string> = sharedMessages[locale],
): string {
  if (typeof value === 'string') return value;
  const text =
    resources[value.key] ??
    sharedMessages[locale][value.key] ??
    sharedMessages['zh-CN'][value.key] ??
    value.key;
  return format(
    text,
    Object.fromEntries(
      Object.entries(value.params).map(([k, v]) => [
        k,
        isMessage(v) ? formatMessage(v, locale, resources) : v,
      ]),
    ),
  );
}

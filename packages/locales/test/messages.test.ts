import { expect, it } from 'vitest';
import {
  diagnosticMessage,
  fallbackText,
  formatMessage,
  isMessage,
  msg,
  normalizeLocale,
  sharedMessages,
} from '../src/index.js';
import { pluralParams, vueMessages } from '../src/ui.js';
it('normalizes supported language families with a deterministic Chinese fallback', () => {
  expect(normalizeLocale('en-US')).toBe('en');
  expect(normalizeLocale('EN-gb')).toBe('en');
  expect(normalizeLocale('zh-Hans')).toBe('zh-CN');
  expect(normalizeLocale('fr')).toBe('zh-CN');
  expect(normalizeLocale(null)).toBe('zh-CN');
});
it('preserves diagnostic identifiers and parameters independently of the rendering locale', () => {
  const key = Object.keys(sharedMessages['zh-CN']).find(
    (key) =>
      sharedMessages['zh-CN'][key] ===
      '操作过于频繁，请等待 {value0} 秒后再试。',
  );
  if (!key) throw new Error('Missing countdown resource');
  const message = msg(key, { value0: 7 });
  expect(isMessage(message)).toBe(true);
  expect(fallbackText(message)).toContain('7 秒');
  expect(formatMessage(message, 'en')).toContain('7');
  expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  expect(message.params).toEqual({ value0: 7 });
});
it('supports existing stored diagnostic text without interpreting arbitrary record content', () => {
  const text = diagnosticMessage('服务暂时不可用，请稍后重试。');
  expect(isMessage(text)).toBe(true);
  expect(formatMessage(text, 'en')).toContain('temporarily unavailable');
  expect(diagnosticMessage('A private record title')).toBe(
    'A private record title',
  );
});
it('keeps Vue plural syntax separate from backend catalog resources', () => {
  const keys = Object.keys(pluralParams);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(vueMessages.en[key]).toContain(' | ');
    if (sharedMessages.en[key])
      expect(sharedMessages.en[key]).not.toContain(' | ');
  }
});

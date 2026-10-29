import { sharedMessages } from './shared/index.js';
import datesZh from './ui/zh-CN/dates.json' with { type: 'json' };
import datesEn from './ui/en/dates.json' with { type: 'json' };
import zh0 from './ui/zh-CN/account.json' with { type: 'json' };
import zh1 from './ui/zh-CN/accountExports.json' with { type: 'json' };
import zh2 from './ui/zh-CN/admissionReview.json' with { type: 'json' };
import zh4 from './ui/zh-CN/app.json' with { type: 'json' };
import zh5 from './ui/zh-CN/appearance.json' with { type: 'json' };
import zh6 from './ui/zh-CN/auth.json' with { type: 'json' };
import zh7 from './ui/zh-CN/categoryManager.json' with { type: 'json' };
import zh8 from './ui/zh-CN/categoryTabs.json' with { type: 'json' };
import zh9 from './ui/zh-CN/colorPicker.json' with { type: 'json' };
import zh10 from './ui/zh-CN/common.json' with { type: 'json' };
import zh11 from './ui/zh-CN/confirm.json' with { type: 'json' };
import zh12 from './ui/zh-CN/data.json' with { type: 'json' };
import zh13 from './ui/zh-CN/deletion.json' with { type: 'json' };
import zh14 from './ui/zh-CN/drafts.json' with { type: 'json' };
import zh15 from './ui/zh-CN/edit.json' with { type: 'json' };
import zh16 from './ui/zh-CN/entryCard.json' with { type: 'json' };
import zh17 from './ui/zh-CN/entryEditor.json' with { type: 'json' };
import zh18 from './ui/zh-CN/entryRow.json' with { type: 'json' };
import zh19 from './ui/zh-CN/file-parser.json' with { type: 'json' };
import zh20 from './ui/zh-CN/fileToolLoading.json' with { type: 'json' };
import zh21 from './ui/zh-CN/fileTools.json' with { type: 'json' };
import zh22 from './ui/zh-CN/focusHelp.json' with { type: 'json' };
import zh24 from './ui/zh-CN/identity.json' with { type: 'json' };
import zh25 from './ui/zh-CN/language.json' with { type: 'json' };
import zh26 from './ui/zh-CN/mini.json' with { type: 'json' };
import zh27 from './ui/zh-CN/native.json' with { type: 'json' };
import zh28 from './ui/zh-CN/presets.json' with { type: 'json' };
import zh29 from './ui/zh-CN/reauthForm.json' with { type: 'json' };
import zh31 from './ui/zh-CN/records.json' with { type: 'json' };
import zh32 from './ui/zh-CN/recordsScreen.json' with { type: 'json' };
import zh33 from './ui/zh-CN/syncStatus.json' with { type: 'json' };
import zh35 from './ui/zh-CN/timelineView.json' with { type: 'json' };
import zh37 from './ui/zh-CN/workspace.json' with { type: 'json' };
import en0 from './ui/en/account.json' with { type: 'json' };
import en1 from './ui/en/accountExports.json' with { type: 'json' };
import en2 from './ui/en/admissionReview.json' with { type: 'json' };
import en4 from './ui/en/app.json' with { type: 'json' };
import en5 from './ui/en/appearance.json' with { type: 'json' };
import en6 from './ui/en/auth.json' with { type: 'json' };
import en7 from './ui/en/categoryManager.json' with { type: 'json' };
import en8 from './ui/en/categoryTabs.json' with { type: 'json' };
import en9 from './ui/en/colorPicker.json' with { type: 'json' };
import en10 from './ui/en/common.json' with { type: 'json' };
import en11 from './ui/en/confirm.json' with { type: 'json' };
import en12 from './ui/en/data.json' with { type: 'json' };
import en13 from './ui/en/deletion.json' with { type: 'json' };
import en14 from './ui/en/drafts.json' with { type: 'json' };
import en15 from './ui/en/edit.json' with { type: 'json' };
import en16 from './ui/en/entryCard.json' with { type: 'json' };
import en17 from './ui/en/entryEditor.json' with { type: 'json' };
import en18 from './ui/en/entryRow.json' with { type: 'json' };
import en19 from './ui/en/file-parser.json' with { type: 'json' };
import en20 from './ui/en/fileToolLoading.json' with { type: 'json' };
import en21 from './ui/en/fileTools.json' with { type: 'json' };
import en22 from './ui/en/focusHelp.json' with { type: 'json' };
import en24 from './ui/en/identity.json' with { type: 'json' };
import en25 from './ui/en/language.json' with { type: 'json' };
import en26 from './ui/en/mini.json' with { type: 'json' };
import en27 from './ui/en/native.json' with { type: 'json' };
import en28 from './ui/en/presets.json' with { type: 'json' };
import en29 from './ui/en/reauthForm.json' with { type: 'json' };
import en31 from './ui/en/records.json' with { type: 'json' };
import en32 from './ui/en/recordsScreen.json' with { type: 'json' };
import en33 from './ui/en/syncStatus.json' with { type: 'json' };
import en35 from './ui/en/timelineView.json' with { type: 'json' };
import en37 from './ui/en/workspace.json' with { type: 'json' };
export const uiMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': {
    ...datesZh,
    ...zh0,
    ...zh1,
    ...zh2,
    ...zh4,
    ...zh5,
    ...zh6,
    ...zh7,
    ...zh8,
    ...zh9,
    ...zh10,
    ...zh11,
    ...zh12,
    ...zh13,
    ...zh14,
    ...zh15,
    ...zh16,
    ...zh17,
    ...zh18,
    ...zh19,
    ...zh20,
    ...zh21,
    ...zh22,
    ...zh24,
    ...zh25,
    ...zh26,
    ...zh27,
    ...zh28,
    ...zh29,
    ...zh31,
    ...zh32,
    ...zh33,
    ...zh35,
    ...zh37,
  },
  en: {
    ...datesEn,
    ...en0,
    ...en1,
    ...en2,
    ...en4,
    ...en5,
    ...en6,
    ...en7,
    ...en8,
    ...en9,
    ...en10,
    ...en11,
    ...en12,
    ...en13,
    ...en14,
    ...en15,
    ...en16,
    ...en17,
    ...en18,
    ...en19,
    ...en20,
    ...en21,
    ...en22,
    ...en24,
    ...en25,
    ...en26,
    ...en27,
    ...en28,
    ...en29,
    ...en31,
    ...en32,
    ...en33,
    ...en35,
    ...en37,
  },
};

/** Vue plural variants are UI-specific; raw server messages retain their own syntax. */
export const pluralParams: Record<string, string> = {};
const en = { ...sharedMessages.en, ...uiMessages.en };
const nouns: Record<string, [string, string]> = {
  day: ['day', 'days'],
  days: ['day', 'days'],
  record: ['record', 'records'],
  records: ['record', 'records'],
  entry: ['entry', 'entries'],
  entries: ['entry', 'entries'],
  category: ['category', 'categories'],
  categories: ['category', 'categories'],
  second: ['second', 'seconds'],
  seconds: ['second', 'seconds'],
  item: ['item', 'items'],
  items: ['item', 'items'],
};
for (const [key, text] of Object.entries(en)) {
  if (text.includes('|')) continue;
  const pattern =
    /\{(value\d+|count)\}(\s+(?:focus\s+)?)(days?|records?|entries|entry|categories|category|seconds?|items?)\b/g;
  const matches = [...text.matchAll(pattern)];
  const variables = new Set(matches.map((m) => m[1]));
  if (variables.size !== 1 || !matches.length) continue;
  const parameter = matches[0]?.[1];
  if (!parameter) continue;
  pluralParams[key] = parameter;
  const one = text.replace(
    pattern,
    (full, name: string, gap: string, unit: string) =>
      '{' + name + '}' + gap + (nouns[unit]?.[0] ?? unit),
  );
  const many = text.replace(
    pattern,
    (full, name: string, gap: string, unit: string) =>
      '{' + name + '}' + gap + (nouns[unit]?.[1] ?? unit),
  );
  en[key] = one + ' | ' + many;
}
export const vueMessages = {
  'zh-CN': { ...sharedMessages['zh-CN'], ...uiMessages['zh-CN'] },
  en,
};

import filesZh from './zh-CN/file-errors.json' with { type: 'json' };
import filesEn from './en/file-errors.json' with { type: 'json' };
import zh0 from './zh-CN/account.json' with { type: 'json' };
import zh1 from './zh-CN/accountExports.json' with { type: 'json' };
import zh2 from './zh-CN/api.json' with { type: 'json' };
import zh3 from './zh-CN/auth.json' with { type: 'json' };
import zh4 from './zh-CN/categoryManager.json' with { type: 'json' };
import zh5 from './zh-CN/categoryTabs.json' with { type: 'json' };
import zh6 from './zh-CN/common.json' with { type: 'json' };
import zh7 from './zh-CN/confirm.json' with { type: 'json' };
import zh8 from './zh-CN/data.json' with { type: 'json' };
import zh9 from './zh-CN/deletion.json' with { type: 'json' };
import zh10 from './zh-CN/drafts.json' with { type: 'json' };
import zh11 from './zh-CN/edit.json' with { type: 'json' };
import zh12 from './zh-CN/entryEditor.json' with { type: 'json' };
import zh13 from './zh-CN/errors.json' with { type: 'json' };
import zh14 from './zh-CN/guest-repository.json' with { type: 'json' };
import zh15 from './zh-CN/identity.json' with { type: 'json' };
import zh16 from './zh-CN/mini.json' with { type: 'json' };
import zh17 from './zh-CN/record-service.json' with { type: 'json' };
import zh18 from './zh-CN/records.json' with { type: 'json' };
import zh19 from './zh-CN/recordsScreen.json' with { type: 'json' };
import zh20 from './zh-CN/theme.json' with { type: 'json' };
import zh21 from './zh-CN/uuid.json' with { type: 'json' };
import zh22 from './zh-CN/workspace.json' with { type: 'json' };
import en0 from './en/account.json' with { type: 'json' };
import en1 from './en/accountExports.json' with { type: 'json' };
import en2 from './en/api.json' with { type: 'json' };
import en3 from './en/auth.json' with { type: 'json' };
import en4 from './en/categoryManager.json' with { type: 'json' };
import en5 from './en/categoryTabs.json' with { type: 'json' };
import en6 from './en/common.json' with { type: 'json' };
import en7 from './en/confirm.json' with { type: 'json' };
import en8 from './en/data.json' with { type: 'json' };
import en9 from './en/deletion.json' with { type: 'json' };
import en10 from './en/drafts.json' with { type: 'json' };
import en11 from './en/edit.json' with { type: 'json' };
import en12 from './en/entryEditor.json' with { type: 'json' };
import en13 from './en/errors.json' with { type: 'json' };
import en14 from './en/guest-repository.json' with { type: 'json' };
import en15 from './en/identity.json' with { type: 'json' };
import en16 from './en/mini.json' with { type: 'json' };
import en17 from './en/record-service.json' with { type: 'json' };
import en18 from './en/records.json' with { type: 'json' };
import en19 from './en/recordsScreen.json' with { type: 'json' };
import en20 from './en/theme.json' with { type: 'json' };
import en21 from './en/uuid.json' with { type: 'json' };
import en22 from './en/workspace.json' with { type: 'json' };
export const sharedMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': {
    ...filesZh,
    ...zh0,
    ...zh1,
    ...zh2,
    ...zh3,
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
  },
  en: {
    ...filesEn,
    ...en0,
    ...en1,
    ...en2,
    ...en3,
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
  },
};

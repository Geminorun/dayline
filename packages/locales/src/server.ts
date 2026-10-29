import zh0 from './server/zh-CN/emails.json' with { type: 'json' };
import en0 from './server/en/emails.json' with { type: 'json' };
export const serverMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': { ...zh0 },
  en: { ...en0 },
};

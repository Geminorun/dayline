import type { Locale } from '@dayline/locales';
export interface Actor {
  userId: string;
  sessionId: string;
  authEpoch: number;
  transport: 'cookie' | 'bearer';
}

declare module 'express-serve-static-core' {
  interface Request {
    daylineLocale?: Locale;
    requestId: string;
    actor?: Actor;
    committedDataVersion?: string;
  }
}

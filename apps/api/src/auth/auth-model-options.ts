import type { BetterAuthOptions } from 'better-auth';

export const authModelOptions = {
  user: {
    additionalFields: {
      locale: { type: 'string', defaultValue: 'zh-CN', input: false },
      emailKind: { type: 'string', defaultValue: 'real', input: false },
      status: { type: 'string', defaultValue: 'active', input: false },
      authEpoch: { type: 'number', defaultValue: 1, input: false },
      profileVersion: { type: 'number', defaultValue: 1, input: false },
      deletionDueAt: { type: 'date', required: false, input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
    additionalFields: {
      authEpoch: { type: 'number', defaultValue: 1, input: false },
      authMethod: {
        type: 'string',
        defaultValue: 'email_password',
        input: false,
      },
    },
  },
  account: { accountLinking: { enabled: false } },
  advanced: { database: { generateId: 'uuid' } },
  telemetry: { enabled: false },
} satisfies BetterAuthOptions;

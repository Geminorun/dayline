import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

export const WORKSPACE_ROOT = fileURLToPath(
  new URL('../../../../', import.meta.url),
);
export const APP_CONFIG = Symbol('APP_CONFIG');

const httpUrl = z.url({ protocol: /^https?$/ });

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  AUTH_BASE_URL: httpUrl,
  AUTH_TRUSTED_ORIGINS: z.string().min(1),
  WEB_BASE_URL: httpUrl,
  BETTER_AUTH_SECRET: z.string().min(32),
  MAIL_TRANSPORT: z.enum(['resend', 'file']),
  MAIL_PREVIEW_DIR: z.string().default('.local/mail'),
  MAIL_FROM: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
});

export type AppConfig = ReturnType<typeof parseEnvironment>;

export function loadEnvironment(): AppConfig {
  dotenvConfig({ path: resolve(WORKSPACE_ROOT, '.env'), quiet: true });
  return parseEnvironment(process.env);
}

export function parseEnvironment(input: Record<string, string | undefined>) {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }

  const env = result.data;
  const trustedOrigins = env.AUTH_TRUSTED_ORIGINS.split(',').map((value) =>
    value.trim(),
  );
  if (
    trustedOrigins.some(
      (origin) =>
        !httpUrl.safeParse(origin).success || new URL(origin).origin !== origin,
    )
  ) {
    throw new Error('AUTH_TRUSTED_ORIGINS must contain exact HTTP(S) origins.');
  }
  if (env.MAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY?.trim()) {
    throw new Error(
      'RESEND_API_KEY is required for the Resend mail transport.',
    );
  }
  if (env.NODE_ENV === 'production') {
    if (env.MAIL_TRANSPORT !== 'resend')
      throw new Error('Production requires the Resend mail transport.');
    if (
      !env.AUTH_BASE_URL.startsWith('https:') ||
      !env.WEB_BASE_URL.startsWith('https:')
    ) {
      throw new Error('Production public URLs must use HTTPS.');
    }
    if (/local-development|replace|change-me/i.test(env.BETTER_AUTH_SECRET)) {
      throw new Error(
        'Replace the development authentication secret before production.',
      );
    }
  }

  return {
    environment: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    authBaseUrl: env.AUTH_BASE_URL,
    trustedOrigins,
    webBaseUrl: env.WEB_BASE_URL,
    authSecret: env.BETTER_AUTH_SECRET,
    mailTransport: env.MAIL_TRANSPORT,
    mailPreviewDirectory: resolve(WORKSPACE_ROOT, env.MAIL_PREVIEW_DIR),
    mailFrom: env.MAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
  };
}

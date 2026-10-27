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
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).optional(),
  EXTERNAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(8000),
  MAINTENANCE_ENABLED: z.enum(['true', 'false']).default('true'),
  TRUST_PROXY: z.string().default(''),
  LOG_LEVEL: z.enum(['error', 'warn', 'info']).default('info'),
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(15000),
  BATCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(60000),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  WEB_DIST_DIR: z.string().min(1).optional(),
  RELEASE_REVISION: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  AUTH_BASE_URL: httpUrl,
  AUTH_TRUSTED_ORIGINS: z.string().min(1),
  WEB_BASE_URL: httpUrl,
  ACTION_PROOF_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  MAIL_TRANSPORT: z.enum(['resend', 'file']),
  MAIL_PREVIEW_DIR: z.string().default('.local/mail'),
  MAIL_FROM: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  WECHAT_MINIAPP_SCAN_PAGE: z
    .string()
    .regex(/^pages\/[a-zA-Z0-9/_-]+$/)
    .default('pages/scan/confirm'),
  WECHAT_MINIAPP_ENV: z
    .enum(['develop', 'trial', 'release'])
    .default('release'),
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
  if (
    env.TRUST_PROXY &&
    env.TRUST_PROXY.split(',').some(
      (v) => !/^(?:[0-9a-fA-F:.]+)(?:\/\d{1,3})?$/.test(v.trim()),
    )
  )
    throw new Error('TRUST_PROXY requires explicit IP addresses or CIDRs.');
  if (env.NODE_ENV === 'production') {
    if (
      !env.ACTION_PROOF_SECRET ||
      env.ACTION_PROOF_SECRET === env.BETTER_AUTH_SECRET
    )
      throw new Error(
        'Production requires an independent ACTION_PROOF_SECRET.',
      );
    if (env.MAIL_TRANSPORT !== 'resend')
      throw new Error('Production requires the Resend mail transport.');
    if (
      !env.AUTH_BASE_URL.startsWith('https:') ||
      !env.WEB_BASE_URL.startsWith('https:')
    ) {
      throw new Error('Production public URLs must use HTTPS.');
    }
    if (/local-development|replace|change-me/i.test(env.ACTION_PROOF_SECRET))
      throw new Error(
        'Replace the development action proof secret before production.',
      );
    if (/local-development|replace|change-me/i.test(env.BETTER_AUTH_SECRET)) {
      throw new Error(
        'Replace the development authentication secret before production.',
      );
    }
  }

  return {
    rateLimitEnabled: env.RATE_LIMIT_ENABLED
      ? env.RATE_LIMIT_ENABLED === 'true'
      : env.NODE_ENV !== 'test',
    externalTimeoutMs: env.EXTERNAL_TIMEOUT_MS,
    maintenanceEnabled: env.MAINTENANCE_ENABLED === 'true',
    trustProxy: env.TRUST_PROXY.split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    batchTimeoutMs: env.BATCH_TIMEOUT_MS,
    environment: env.NODE_ENV,
    host: env.HOST,
    webDistDirectory: env.WEB_DIST_DIR,
    releaseRevision: env.RELEASE_REVISION,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    authBaseUrl: env.AUTH_BASE_URL,
    trustedOrigins,
    webBaseUrl: env.WEB_BASE_URL,
    authSecret: env.BETTER_AUTH_SECRET,
    actionProofSecret:
      env.ACTION_PROOF_SECRET ??
      `dayline-action-proof:${env.BETTER_AUTH_SECRET}`,
    mailTransport: env.MAIL_TRANSPORT,
    mailPreviewDirectory: resolve(WORKSPACE_ROOT, env.MAIL_PREVIEW_DIR),
    mailFrom: env.MAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    wechatAppId: env.WECHAT_APP_ID,
    wechatAppSecret: env.WECHAT_APP_SECRET,
    wechatScanPage: env.WECHAT_MINIAPP_SCAN_PAGE,
    wechatEnvironment: env.WECHAT_MINIAPP_ENV,
  };
}

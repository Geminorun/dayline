import { requestBudget } from '../common/request-budget.js';
import type { SecurityService } from '../security/security.service.js';
import { AppError } from '../common/app-error.js';
import { decodeJwt } from 'jose';
import { createHash } from 'node:crypto';
import { Clock } from '../records/clock.js';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { displayNameSchema } from '@dayline/contracts';
import type { AppConfig } from '../config/environment.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { MailService } from '../mail/mail.service.js';
import { identityPlugin } from './adapter/identity-plugin.js';
import { authModelOptions } from './auth-model-options.js';

export const AUTH_INSTANCE = Symbol('AUTH_INSTANCE');
export type DaylineAuth = ReturnType<typeof createAuth>;

export function createAuth(
  config: AppConfig,
  database: PrismaService,
  mail: MailService,
  clock: Clock = new Clock(),
  security?: SecurityService,
) {
  const baseAdapter = prismaAdapter(database, {
    provider: 'postgresql',
    transaction: true,
  });
  return betterAuth({
    ...authModelOptions,
    appName: '日序 Dayline',
    logger: { disabled: true },
    secret: config.authSecret,
    baseURL: config.authBaseUrl,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    database: (options: Parameters<typeof baseAdapter>[0]) => {
      const adapter = baseAdapter(options);
      return {
        ...adapter,
        update: async <T>(
          input: Parameters<typeof adapter.update>[0],
        ): Promise<T | null> => {
          const owner = requestBudget.getStore()?.verificationUserId;
          if (owner && input.model === 'user') {
            // The final BA UPDATE includes UUID and active state in its SQL WHERE.
            // Releasing/re-registering an email between lookup and update cannot target a new account.
            const result = await adapter.update<T>({
              ...input,
              where: [
                ...input.where,
                { field: 'id', value: owner },
                { field: 'status', value: 'active' },
              ],
            });
            if (!result)
              throw new APIError('BAD_REQUEST', {
                code: 'TOKEN_INVALID',
                message: '验证链接已失效，请重新申请。',
              });
            return result;
          }
          return adapter.update<T>(input);
        },
      };
    },
    plugins: [bearer({ requireSignature: true }), identityPlugin()],
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 30,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mail.sendPasswordReset(user.email, url);
      },
      onPasswordReset: async ({ user }) => {
        await database.user.update({
          where: { id: user.id },
          data: { authEpoch: { increment: 1 } },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        const token = new URL(url).searchParams.get('token');
        if (!token) throw new Error('Missing email verification token.');
        const identifier =
          'dayline-email-verification:' +
          createHash('sha256').update(token).digest('hex');
        await database.verification.create({
          data: {
            identifier,
            value: user.id,
            expiresAt: new Date(clock.now().getTime() + 86400000),
          },
        });
        await mail.sendVerification(user.email, url);
      },
    },
    advanced: {
      ...authModelOptions.advanced,
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: {
      enabled: config.rateLimitEnabled,
      storage: 'memory',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 60 },
        '/sign-up/email': { window: 60, max: 20 },
        '/send-verification-email': { window: 60, max: 20 },
        '/request-password-reset': { window: 60, max: 20 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === '/verify-email') {
          const token = context.query?.token;
          const record =
            typeof token === 'string'
              ? await database.verification.findFirst({
                  where: {
                    identifier:
                      'dayline-email-verification:' +
                      createHash('sha256').update(token).digest('hex'),
                    expiresAt: { gt: clock.now() },
                  },
                })
              : null;
          const scope = requestBudget.getStore();
          if (!scope)
            throw new APIError('BAD_REQUEST', {
              message: '验证上下文不可用，请重新打开链接。',
            });
          const owner = record
            ? await database.user.findUnique({ where: { id: record.value } })
            : null;
          if (
            !owner ||
            typeof token !== 'string' ||
            decodeJwt(token).email !== owner.email ||
            owner.status !== 'active'
          )
            throw new APIError('BAD_REQUEST', {
              message: '验证链接已失效，请重新申请。',
            });
          scope.verificationUserId = owner.id;
        }
        const email = context.body?.email;
        const scope = requestBudget.getStore();
        if (scope) {
          scope.authPath = context.path;
          scope.authEmail =
            typeof email === 'string' ? email.trim().toLowerCase() : '';
        }
        if (security) {
          try {
            security.nativeIdentity(
              context.path,
              typeof email === 'string' ? email : '',
              context.headers?.get('X-Dayline-Internal-IP') ?? 'unknown',
            );
          } catch (e) {
            if (e instanceof AppError) {
              context.setHeader(
                'Retry-After',
                context.path === '/sign-in/email' ? '600' : '60',
              );
              throw new APIError(
                'TOO_MANY_REQUESTS',
                { message: e.message, code: 'RATE_LIMITED' },
                {
                  'Retry-After':
                    context.path === '/sign-in/email' ? '600' : '60',
                },
              );
            }
            throw e;
          }
        }
        if (
          typeof email === 'string' &&
          email.trim().toLowerCase().endsWith('.invalid')
        ) {
          throw new APIError('BAD_REQUEST', {
            message: '请使用可接收邮件的真实邮箱。',
          });
        }
        if (context.path === '/sign-up/email') {
          const name = displayNameSchema.safeParse(context.body?.name);
          if (!name.success)
            throw new APIError('BAD_REQUEST', {
              message: '显示名须为 1–40 个字符。',
            });
          context.body.name = name.data;
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await database.user.findUnique({
              where: { id: session.userId },
            });
            if (
              !user ||
              user.status === 'merged' ||
              (user.status === 'pending_deletion' &&
                user.deletionDueAt !== null &&
                user.deletionDueAt <= clock.now())
            )
              return false;
            return { data: { ...session, authEpoch: user.authEpoch } };
          },
        },
      },
    },
  });
}

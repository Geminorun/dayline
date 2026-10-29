import { errorMessageKeys, msg, normalizeLocale } from '@dayline/locales';

import { serverText, requestLocale } from '../i18n/server-text.js';
import { requestBudget } from '../common/request-budget.js';
import { Logger } from '@nestjs/common';
import { errorDiagnostics } from '../common/error-diagnostics.js';
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
import { EmailVerificationFlow } from './email-verification-flow.js';

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
  const logger = new Logger('Authentication');
  const emailFlow = new EmailVerificationFlow(config, database, mail, clock);
  return betterAuth({
    ...authModelOptions,
    appName: '日序 Dayline',
    logger: {
      disabled: config.environment === 'test',
      level: 'warn',
      log: (level, _message, ...args: unknown[]) => {
        const event = {
          code: level === 'error' ? 'AUTH_INTERNAL_ERROR' : 'AUTH_WARNING',
          ...errorDiagnostics(args.find((arg) => arg instanceof Error)),
        };
        // Better Auth's free-form messages and arguments can contain credentials.
        if (level === 'error') logger.error(event);
        else if (level === 'warn') logger.warn(event);
      },
    },
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
                message: serverText(
                  msg('errors.theVerificationLinkHasExpiredPleaseApply'),
                ),
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
        const profile = await database.user.findUnique({
          where: { id: user.id },
          select: { locale: true },
        });
        await mail.sendPasswordReset(
          user.email,
          url,
          normalizeLocale(profile?.locale),
        );
      },
      onExistingUserSignUp: async ({ user }, request) =>
        emailFlow.resume(user, request),
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
        await emailFlow.send(user, url);
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
              message: serverText(
                msg('errors.authenticationContextIsNotAvailablePleaseReopen'),
              ),
            });
          const owner = record
            ? await database.user.findUnique({ where: { id: record.value } })
            : null;
          if (
            !owner ||
            typeof token !== 'string' ||
            decodeJwt(token).email !== owner.email ||
            owner.status !== 'active'
          ) {
            const target = context.query?.callbackURL;
            if (
              typeof target === 'string' &&
              URL.canParse(target, config.webBaseUrl)
            ) {
              const callback = new URL(target, config.webBaseUrl);
              if (config.trustedOrigins.includes(callback.origin)) {
                callback.pathname = '/verify';
                callback.hash = '';
                callback.searchParams.set('error', 'INVALID_TOKEN');
                throw context.redirect(callback.href);
              }
            }
            throw new APIError('BAD_REQUEST', {
              message: serverText(
                msg('errors.theVerificationLinkHasExpiredPleaseApply'),
              ),
            });
          }
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
            const retry = security.nativeIdentity(
              context.path,
              typeof email === 'string' ? email : '',
              context.headers?.get('X-Dayline-Internal-IP') ?? 'unknown',
            );
            if (scope) {
              scope.mailRetrySeconds = retry;
              if (retry > 0) scope.mailRetryUntil = Date.now() + retry * 1000;
            }
            if (retry > 0) context.setHeader('Retry-After', String(retry));
          } catch (e) {
            if (e instanceof AppError) {
              const details = e.details;
              const retry =
                details &&
                typeof details === 'object' &&
                'retryAfterSeconds' in details &&
                typeof details.retryAfterSeconds === 'number'
                  ? String(details.retryAfterSeconds)
                  : context.path === '/sign-in/email'
                    ? '600'
                    : '60';
              context.setHeader('Retry-After', retry);
              throw new APIError(
                'TOO_MANY_REQUESTS',
                {
                  message: serverText(e.localized ?? e.message),
                  code: 'RATE_LIMITED',
                },
                {
                  'Retry-After': retry,
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
            message: serverText(msg('errors.pleaseUseARealEmailAddressThat')),
          });
        }
        if (context.path === '/sign-up/email') {
          const name = displayNameSchema.safeParse(context.body?.name);
          if (!name.success)
            throw new APIError('BAD_REQUEST', {
              message: serverText(msg('errors.displayNameMustBe140Characters')),
            });
          context.body.name = name.data;
        }
        if (
          typeof email === 'string' &&
          ['/sign-up/email', '/send-verification-email'].includes(context.path)
        )
          await emailFlow.prepare(email.trim().toLowerCase());
      }),
      after: createAuthMiddleware(async (context) => {
        const failure = context.context.returned;
        if (
          failure instanceof APIError &&
          typeof failure.body?.code === 'string'
        ) {
          const key = errorMessageKeys[failure.body.code];
          if (key) failure.body.message = serverText(msg(key));
        }

        const scope = requestBudget.getStore();
        const remaining =
          scope?.mailRetryUntil === undefined
            ? undefined
            : Math.max(
                0,
                Math.ceil((scope.mailRetryUntil - Date.now()) / 1000),
              );
        if (remaining !== undefined)
          context.setHeader('Retry-After', String(remaining));
        const flow = scope?.emailFlow;
        if (flow && remaining !== undefined) flow.retryAfterSeconds = remaining;
        if (
          !flow ||
          !['/sign-up/email', '/send-verification-email'].includes(context.path)
        )
          return;
        const returned: unknown = context.context.returned;
        if (
          returned instanceof APIError &&
          !['failed', 'unconfirmed'].includes(flow.mailStatus)
        )
          return;
        const legacy =
          flow.accountStatus === 'created' &&
          returned &&
          typeof returned === 'object' &&
          !(returned instanceof APIError)
            ? returned
            : { status: true };
        logger.log({
          code: 'AUTH_EMAIL_FLOW',
          operation: context.path,
          accountStatus: flow.accountStatus,
          nextStep: flow.nextStep,
          mailStatus: flow.mailStatus,
          retryAfterSeconds: flow.retryAfterSeconds,
        });
        return context.json({ ...legacy, emailFlow: flow });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              locale: requestLocale(),
            },
          }),
        },
      },
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

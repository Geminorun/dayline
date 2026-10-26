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
) {
  return betterAuth({
    ...authModelOptions,
    appName: '日序 Dayline',
    logger: { disabled: true },
    secret: config.authSecret,
    baseURL: config.authBaseUrl,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    database: prismaAdapter(database, {
      provider: 'postgresql',
      transaction: true,
    }),
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
        await mail.sendVerification(user.email, url);
      },
    },
    rateLimit: {
      enabled: config.environment !== 'test',
      storage: 'memory',
      window: 60,
      max: 60,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const email = context.body?.email;
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
            if (!user || user.status === 'merged') return false;
            return { data: { ...session, authEpoch: user.authEpoch } };
          },
        },
      },
    },
  });
}

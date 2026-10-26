import { realEmailSchema } from '@dayline/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { AUTH_INSTANCE } from '../create-auth.js';
import type { DaylineAuth } from '../create-auth.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AppError } from '../../common/app-error.js';

/** All Better Auth server/internal APIs are confined to this adapter and its plugin. */
@Injectable()
export class AuthAdapter {
  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: DaylineAuth,
    @Inject(PrismaService) private readonly database: PrismaService,
  ) {}

  readSession(headers: Headers, disableRefresh = false) {
    return this.auth.api.getSession({
      headers,
      query: { disableRefresh },
      returnHeaders: true,
    });
  }

  signOut(headers: Headers) {
    return this.auth.api.signOut({ headers, asResponse: true });
  }

  async createWechatSession(userId: string) {
    try {
      const result = await this.auth.api.createDaylineSession({
        body: { userId },
        returnHeaders: true,
      });
      return { headers: result.headers, expiresAt: result.response.expiresAt };
    } catch {
      throw new AppError(
        503,
        'AUTH_UNAVAILABLE',
        '登录会话创建失败，请重新登录或扫码。',
      );
    }
  }

  async passwordValid(userId: string, password: string) {
    const account = await this.database.account.findFirst({
      where: { userId, providerId: 'credential' },
    });
    if (!account?.password) return false;
    const context = await this.auth.$context;
    return context.password.verify({ hash: account.password, password });
  }
  async hashPassword(password: string) {
    if (password.length < 8 || password.length > 128)
      throw new AppError(422, 'VALIDATION_ERROR', '密码须为 8–128 字符。');
    return (await this.auth.$context).password.hash(password);
  }
  async bindEmail(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
    passwordHash: string,
  ) {
    await tx.user.update({
      where: { id: userId },
      data: {
        email: realEmailSchema.parse(email),
        emailKind: 'real',
        emailVerified: true,
        authEpoch: { increment: 1 },
      },
    });
    await tx.account.create({
      data: {
        userId,
        accountId: userId,
        providerId: 'credential',
        password: passwordHash,
      },
    });
    await tx.session.deleteMany({ where: { userId } });
  }
  async migrateCredentials(
    tx: Prisma.TransactionClient,
    sourceId: string,
    targetId: string,
    verifiedEmail?: string,
  ) {
    const source = await tx.user.findUniqueOrThrow({ where: { id: sourceId } });
    const target = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
    if (source.emailKind === 'real') {
      if (target.emailKind === 'real')
        throw new AppError(
          409,
          'IDENTITY_COMBINATION_UNSUPPORTED',
          '首版只支持一个邮箱和一个微信；双方账号保持独立。',
        );
      await tx.user.update({
        where: { id: sourceId },
        data: {
          email: `merged-${sourceId}@identity.dayline.invalid`,
          emailKind: 'internal',
          emailVerified: false,
        },
      });
      await tx.user.update({
        where: { id: targetId },
        data: {
          email: source.email,
          emailKind: 'real',
          emailVerified: source.emailVerified || verifiedEmail === source.email,
        },
      });
    }
    await tx.account.updateMany({
      where: { userId: sourceId, providerId: 'credential' },
      data: { userId: targetId, accountId: targetId },
    });
    await tx.wechatIdentity.updateMany({
      where: { userId: sourceId },
      data: { userId: targetId },
    });
    // Tokens issued before ownership changed must never verify or reset a source shell.
    await tx.verification.deleteMany({
      where: {
        OR: [
          { identifier: { contains: sourceId } },
          { identifier: source.email },
          { value: { contains: sourceId } },
        ],
      },
    });
  }

  /** Service-only primitive for a future binding flow AFTER both proofs are verified.
   * No HTTP endpoint exposes this primitive. Gate-A exercises it directly. */
  async setVerifiedEmailAndPassword(
    userId: string,
    email: string,
    password: string,
  ) {
    const normalizedEmail = realEmailSchema.safeParse(email);
    if (
      password.length < 8 ||
      password.length > 128 ||
      !normalizedEmail.success
    ) {
      throw new AppError(400, 'INVALID_CREDENTIAL', '邮箱或密码不符合要求。');
    }
    const context = await this.auth.$context;
    const hash = await context.password.hash(password);
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.user.updateMany({
          where: { id: userId, emailKind: 'internal', status: 'active' },
          data: {
            email: normalizedEmail.data,
            emailKind: 'real',
            emailVerified: true,
            authEpoch: { increment: 1 },
          },
        });
        if (updated.count !== 1)
          throw new AppError(409, 'IDENTITY_CONFLICT', '账号身份已变化。');
        if (
          await transaction.account.count({
            where: { userId, providerId: 'credential' },
          })
        )
          throw new AppError(409, 'IDENTITY_CONFLICT', '账号已具有密码凭据。');
        await transaction.account.create({
          data: {
            userId,
            accountId: userId,
            providerId: 'credential',
            password: hash,
          },
        });
        await transaction.session.deleteMany({ where: { userId } });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppError(409, 'IDENTITY_CONFLICT', '邮箱已被其他账号使用。');
      throw error;
    }
  }
}

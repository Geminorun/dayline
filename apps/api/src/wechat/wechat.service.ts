import { Clock } from '../records/clock.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { WechatIdentityProof } from './wechat-adapter.js';

@Injectable()
export class WechatService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PrismaService) private readonly database: PrismaService,
  ) {}

  async findOrCreate(proof: WechatIdentityProof): Promise<string> {
    return this.database.transaction((transaction) =>
      this.findOrCreateInTransaction(proof, transaction),
    );
  }

  async findOrCreateInTransaction(
    proof: WechatIdentityProof,
    transaction: Prisma.TransactionClient,
  ): Promise<string> {
    // Lock only this identity; a losing concurrent login cannot leave an orphan user.
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${proof.appId + ':' + proof.openid}))`;
    const existing = await transaction.wechatIdentity.findUnique({
      where: { appId_openid: { appId: proof.appId, openid: proof.openid } },
      include: { user: true },
    });
    if (existing) {
      if (
        existing.user.status === 'merged' ||
        (existing.user.status === 'pending_deletion' &&
          existing.user.deletionDueAt &&
          existing.user.deletionDueAt <= this.clock.now())
      )
        throw new AppError(403, 'ACCOUNT_UNAVAILABLE', '账号暂不可登录。');
      return existing.userId;
    }
    const user = await transaction.user.create({
      data: {
        name: '微信用户',
        email: `wx-${randomUUID()}@identity.dayline.invalid`,
        emailKind: 'internal',
        emailVerified: false,
        wechatIdentities: {
          create: {
            appId: proof.appId,
            openid: proof.openid,
            ...(proof.unionid ? { unionid: proof.unionid } : {}),
          },
        },
      },
    });
    return user.id;
  }
}

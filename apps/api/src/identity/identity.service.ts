import { Clock } from '../records/clock.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { realEmailSchema } from '@dayline/contracts';
import type { ActionRequest, BindingResult } from '@dayline/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { WechatIdentityProof } from '../wechat/wechat-adapter.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
import { ActionProofService } from '../auth/action-proof.service.js';
import { AuthAdapter } from '../auth/adapter/auth-adapter.js';
import { MailService } from '../mail/mail.service.js';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const identityJson = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class IdentityService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ActionProofService) private readonly proofs: ActionProofService,
    @Inject(AuthAdapter) private readonly auth: AuthAdapter,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  private transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout?: number } = {},
  ) {
    return this.db.$transaction(work, {
      maxWait: 10000,
      timeout: 60000,
      ...options,
    });
  }

  async grant(
    tx: Prisma.TransactionClient,
    actor: Actor,
    otherId: string,
    operationId: string,
    expiresAt: Date,
  ) {
    const current = await this.proofs.current(tx, actor);
    const other = await tx.user.findUniqueOrThrow({ where: { id: otherId } });
    if (other.status !== 'active' || current.status !== 'active')
      throw new AppError(409, 'PREVIEW_STALE', '账号状态已变化。');
    const context = await tx.mergeContext.create({
      data: {
        id: randomUUID(),
        initiatorUserId: actor.userId,
        otherUserId: otherId,
        sessionId: actor.sessionId,
        operationId,
        initiatorEpoch: actor.authEpoch,
        otherEpoch: other.authEpoch,
        expiresAt,
      },
    });
    return {
      status: 'merge_required',
      mergeContext: context.id,
    } satisfies BindingResult;
  }
  async requestEmail(
    actor: Actor,
    email: string,
    operationId: string,
    proof: string,
  ) {
    const normalized = realEmailSchema.parse(email);
    await this.proofs.verify(proof, actor, {
      purpose: 'bind_email',
      operationId,
      target: normalized,
    });
    const token = randomBytes(32).toString('base64url');
    const row = await this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
      const user = await this.proofs.current(tx, actor);
      if (user.emailKind === 'real')
        throw new AppError(
          409,
          'IDENTITY_COMBINATION_UNSUPPORTED',
          '当前账号已有邮箱，首版不支持替换或添加第二个邮箱。',
        );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'binding-email:' + normalized}))`;
      const recent = await tx.emailBindingRequest.findFirst({
        where: {
          OR: [{ userId: actor.userId }, { email: normalized }],
          createdAt: { gt: new Date(this.clock.now().getTime() - 60000) },
        },
      });
      if (recent)
        throw new AppError(
          429,
          'RATE_LIMITED',
          '邮件已申请，请至少一分钟后重发。',
        );
      const old = await tx.emailBindingRequest.findUnique({
        where: { userId_operationId: { userId: actor.userId, operationId } },
      });
      if (old && old.email !== normalized)
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          '请为新的邮箱重新开始操作。',
        );
      if (old && ['consumed', 'cancelled'].includes(old.status))
        throw new AppError(
          409,
          'BINDING_ENDED',
          '绑定已结束，请重新读取账号。',
        );
      if (
        old &&
        old.expiresAt > this.clock.now() &&
        old.createdAt.getTime() > this.clock.now().getTime() - 60_000
      )
        throw new AppError(
          429,
          'RATE_LIMITED',
          '邮件已申请，请至少一分钟后重发。',
        );
      return tx.emailBindingRequest.upsert({
        where: { userId_operationId: { userId: actor.userId, operationId } },
        create: {
          id: randomUUID(),
          userId: actor.userId,
          sessionId: actor.sessionId,
          authEpoch: actor.authEpoch,
          operationId,
          email: normalized,
          tokenHash: hash(token),
          expiresAt: new Date(this.clock.now().getTime() + 1_800_000),
        },
        update: {
          tokenHash: hash(token),
          status: 'pending',
          sessionId: actor.sessionId,
          authEpoch: actor.authEpoch,
          verifiedAt: null,
          expiresAt: new Date(this.clock.now().getTime() + 1_800_000),
          createdAt: this.clock.now(),
        },
      });
    });
    const url = new URL('/auth/email-binding', this.config.webBaseUrl);
    url.searchParams.set('id', row.id);
    url.searchParams.set('token', token);
    try {
      await this.mail.sendEmailBinding(normalized, url.toString());
    } catch {
      throw new AppError(
        503,
        'MAIL_UNAVAILABLE',
        '邮件暂时不可用，请稍后重发。',
      );
    }
    // Registered and unused addresses follow precisely the same response and mail path.
    return { status: 'pending', id: row.id } satisfies BindingResult;
  }
  async verifyEmail(id: string, token: string) {
    const row = await this.db.emailBindingRequest.findFirst({
      where: {
        id,
        tokenHash: hash(token),
        status: { in: ['pending', 'verified'] },
        expiresAt: { gt: this.clock.now() },
      },
    });
    if (!row)
      throw new AppError(
        403,
        'BINDING_LINK_INVALID',
        '验证链接已失效，请回原设备重新申请。',
      );
    const changed = await this.db.emailBindingRequest.updateMany({
      where: {
        id,
        tokenHash: hash(token),
        status: { in: ['pending', 'verified'] },
        expiresAt: { gt: this.clock.now() },
      },
      data: { status: 'verified', verifiedAt: this.clock.now() },
    });
    if (!changed.count)
      throw new AppError(403, 'BINDING_LINK_INVALID', '验证链接已失效。');
    return { success: true as const };
  }
  async completeEmail(
    actor: Actor,
    id: string,
    input: {
      operationId: string;
      proof: string;
      password?: string | undefined;
      otherPassword?: string | undefined;
    },
  ) {
    const row = await this.db.emailBindingRequest.findFirst({
      where: { id, userId: actor.userId, operationId: input.operationId },
    });
    if (!row) throw new AppError(404, 'RESOURCE_NOT_FOUND', '绑定请求不存在。');
    const claims = await this.proofs.verify(input.proof, actor, {
      purpose: 'bind_email',
      operationId: input.operationId,
      target: row.email,
    });
    const other = await this.db.user.findUnique({
      where: { email: row.email },
    });
    let otherAuthenticated = false;
    if (other && other.id !== actor.userId && input.otherPassword)
      otherAuthenticated = await this.auth.passwordValid(
        other.id,
        input.otherPassword,
      );
    const passwordHash =
      !other && input.password
        ? await this.auth.hashPassword(input.password)
        : null;
    try {
      return await this.transaction(async (tx) => {
        const ids = [
          ...new Set([actor.userId, ...(other ? [other.id] : [])]),
        ].sort();
        for (const uid of ids)
          await tx.$queryRaw`SELECT id FROM users WHERE id=${uid}::uuid FOR UPDATE`;
        const user = await this.proofs.current(tx, actor);
        await this.proofs.verify(input.proof, actor, {
          purpose: 'bind_email',
          operationId: input.operationId,
          target: row.email,
        });
        await tx.$queryRaw`SELECT id FROM email_binding_requests WHERE id=${id}::uuid FOR UPDATE`;
        const current = await tx.emailBindingRequest.findUniqueOrThrow({
          where: { id },
        });
        if (current.status === 'consumed' && user.email === row.email)
          return {
            status: 'bound',
            reauthenticate: false,
          } satisfies BindingResult;
        if (
          current.status !== 'verified' ||
          current.expiresAt <= this.clock.now() ||
          current.authEpoch !== actor.authEpoch
        )
          throw new AppError(
            403,
            'REAUTH_REQUIRED',
            '请完成邮件验证并在原账号重新验证后继续。',
          );
        // The new session must supply its own fresh proof; the old proof never crosses SID.
        if (current.sessionId !== actor.sessionId)
          await tx.emailBindingRequest.update({
            where: { id },
            data: { sessionId: actor.sessionId },
          });
        if (user.emailKind === 'real')
          throw new AppError(
            409,
            'IDENTITY_COMBINATION_UNSUPPORTED',
            '当前账号已具有真实邮箱，双方保持独立。',
          );
        const occupied = await tx.user.findUnique({
          where: { email: row.email },
        });
        if (occupied) {
          if (
            !otherAuthenticated ||
            occupied.id !== other?.id ||
            occupied.authEpoch !== other.authEpoch ||
            occupied.status !== 'active'
          )
            throw new AppError(
              403,
              'REAUTH_REQUIRED',
              '请验证该邮箱账号的当前密码后继续；当前会话仍有效。',
            );
          // The fresh mailbox event + current credential prove B, scoped to A's session and this operation.
          return this.grant(
            tx,
            actor,
            occupied.id,
            input.operationId,
            new Date(
              Math.min(claims.exp * 1000, this.clock.now().getTime() + 300_000),
            ),
          );
        }
        if (!passwordHash)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            '请设置 8–128 字符的新密码。',
          );
        await this.auth.bindEmail(tx, actor.userId, row.email, passwordHash);
        await tx.emailBindingRequest.update({
          where: { id },
          data: { status: 'consumed' },
        });
        return {
          status: 'bound',
          reauthenticate: true,
        } satisfies BindingResult;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppError(
          409,
          'IDENTITY_ALREADY_LINKED',
          '邮箱关联已变化，请重新验证后继续。',
        );
      throw error;
    }
  }
  async bindWechat(
    actor: Actor,
    wx: WechatIdentityProof,
    operationId: string,
    proof: string,
  ) {
    const claims = await this.proofs.verify(proof, actor, {
      purpose: 'bind_wechat',
      operationId,
      target: 'wechat',
    });
    const candidate = await this.db.wechatIdentity.findUnique({
      where: { appId_openid: { appId: wx.appId, openid: wx.openid } },
      include: { user: true },
    });
    return this.transaction(async (tx) => {
      for (const uid of [
        ...new Set([actor.userId, ...(candidate ? [candidate.userId] : [])]),
      ].sort())
        await tx.$queryRaw`SELECT id FROM users WHERE id=${uid}::uuid FOR UPDATE`;
      await this.proofs.current(tx, actor);
      await this.proofs.verify(proof, actor, {
        purpose: 'bind_wechat',
        operationId,
        target: 'wechat',
      });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wx.appId + ':' + wx.openid}))`;
      const identity = await tx.wechatIdentity.findUnique({
        where: { appId_openid: { appId: wx.appId, openid: wx.openid } },
        include: { user: true },
      });
      if (
        (candidate?.userId ?? null) !== (identity?.userId ?? null) ||
        (identity && candidate?.user.authEpoch !== identity.user.authEpoch)
      )
        throw new AppError(
          409,
          'PREVIEW_STALE',
          '微信关联已变化，请重新验证。',
        );
      if (identity?.userId === actor.userId)
        return {
          status: 'bound',
          reauthenticate: false,
        } satisfies BindingResult;
      if (identity)
        return this.grant(
          tx,
          actor,
          identity.userId,
          operationId,
          new Date(claims.exp * 1000),
        );
      if (await tx.wechatIdentity.count({ where: { userId: actor.userId } }))
        throw new AppError(
          409,
          'IDENTITY_COMBINATION_UNSUPPORTED',
          '此账号已有微信，不能替换或添加第二个微信。',
        );
      await tx.wechatIdentity.create({
        data: {
          userId: actor.userId,
          appId: wx.appId,
          openid: wx.openid,
          unionid: wx.unionid ?? null,
        },
      });
      await tx.user.update({
        where: { id: actor.userId },
        data: { authEpoch: { increment: 1 } },
      });
      await tx.session.deleteMany({ where: { userId: actor.userId } });
      return { status: 'bound', reauthenticate: true } satisfies BindingResult;
    });
  }
  async cancelEmail(actor: Actor, id: string) {
    return this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
      await this.proofs.current(tx, actor);
      const row = await tx.emailBindingRequest.updateMany({
        where: {
          id,
          userId: actor.userId,
          status: { in: ['pending', 'verified', 'cancelled'] },
        },
        data: { status: 'cancelled' },
      });
      if (!row.count)
        throw new AppError(
          404,
          'RESOURCE_NOT_FOUND',
          '绑定请求不存在或已完成。',
        );
      const request = await tx.emailBindingRequest.findUniqueOrThrow({
        where: { id },
      });
      await tx.mergeContext.deleteMany({
        where: {
          initiatorUserId: actor.userId,
          operationId: request.operationId,
        },
      });
      await tx.accountMerge.updateMany({
        where: {
          initiatorUserId: actor.userId,
          operationId: request.operationId,
          status: 'preview',
        },
        data: { status: 'cancelled' },
      });
      return { success: true as const };
    });
  }
  async passwordReauth(
    actor: Actor,
    input: ActionRequest & { password?: string | undefined },
  ) {
    if (
      !input.password ||
      !(await this.auth.passwordValid(actor.userId, input.password))
    )
      throw new AppError(
        403,
        'REAUTH_REQUIRED',
        '密码验证未通过，当前会话仍有效。',
      );
    return this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
      await this.proofs.current(tx, actor, true);
      return this.proofs.issue(actor, input);
    });
  }
}

import { msg } from '@dayline/locales';
import { Clock } from '../records/clock.js';
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ActionProofService } from '../auth/action-proof.service.js';
import { IdentityService, identityJson } from '../identity/identity.service.js';
import type { Actor } from '../common/request-context.js';
import type { ActionRequest, QrStatusDto } from '@dayline/contracts';
import { QR_STATUSES } from '@dayline/contracts';

import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { QrRequest } from '../generated/prisma/client.js';
import { AppError } from '../common/app-error.js';
import { WECHAT_ADAPTER } from './wechat-adapter.js';
import type { WechatAdapter } from './wechat-adapter.js';
import { WechatService } from './wechat.service.js';

export const hashSecret = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const randomSecret = () => randomBytes(32).toString('base64url');

@Injectable()
export class QrService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(PrismaService) private readonly database: PrismaService,
    @Inject(WECHAT_ADAPTER) private readonly wechat: WechatAdapter,
    @Inject(WechatService) private readonly identities: WechatService,
    @Inject(ActionProofService) private readonly proofs: ActionProofService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout?: number } = {},
  ) {
    return this.database.transaction(work, {
      maxWait: 10000,
      timeout: 60000,
      ...options,
    });
  }

  async create(
    id: string,
    purpose: string,
    actor?: Actor,
    action?: ActionRequest & { proof?: string | undefined },
  ) {
    if (purpose !== 'login') {
      try {
        return await this.createAction(id, purpose, actor, action);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw new AppError(
            409,
            'QR_REQUEST_EXISTS',
            msg('errors.theQrCodeScanningRequestAlreadyExists'),
          );
        throw error;
      }
    }
    if (purpose !== 'login')
      throw new AppError(
        409,
        'QR_PURPOSE_UNAVAILABLE',
        msg('errors.wechatBindingWillBeEnabledDuringThe'),
      );
    const scene = randomBytes(24).toString('base64url');
    const secret = randomSecret();
    // External failure must not return a fake QR or leave a usable request.
    const miniappCode = await this.wechat.createMiniappCode(scene);
    let row: QrRequest;
    try {
      row = await this.database.qrRequest.create({
        data: {
          id,
          purpose,
          browserSecretHash: hashSecret(secret),
          sceneHash: hashSecret(scene),
          expiresAt: new Date(this.clock.now().getTime() + 120_000),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new AppError(
          409,
          'QR_REQUEST_EXISTS',
          msg('errors.theRequestHasBeenCreatedPleaseGenerate'),
        );
      throw error;
    }
    return { data: { ...this.dto(row), miniappCode }, secret };
  }

  private dto(row: QrRequest): QrStatusDto {
    if (!['login', 'bind_wechat', 'reauth'].includes(row.purpose))
      throw new AppError(
        409,
        'QR_PURPOSE_UNAVAILABLE',
        msg('errors.scanCodeUsageIsNotSupported'),
      );
    return {
      id: row.id,
      purpose: z.enum(['login', 'bind_wechat', 'reauth']).parse(row.purpose),
      status: z.enum(QR_STATUSES).parse(row.status),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private async expire(row: QrRequest) {
    if (
      row.expiresAt.getTime() <= this.clock.now().getTime() &&
      ['pending', 'scanned', 'confirmed'].includes(row.status)
    ) {
      await this.database.qrRequest.updateMany({
        where: {
          id: row.id,
          status: { in: ['pending', 'scanned', 'confirmed'] },
          expiresAt: { lte: this.clock.now() },
        },
        data: {
          status: 'expired',
          scannerOpenid: null,
          scannerUnionid: null,
          scannerSecretHash: null,
        },
      });
      return this.database.qrRequest.findUniqueOrThrow({
        where: { id: row.id },
      });
    }
    return row;
  }

  private async browser(id: string, secret: string) {
    const row = await this.database.qrRequest.findFirst({
      where: { id, browserSecretHash: hashSecret(secret) },
    });
    if (!secret || !row)
      throw new AppError(
        404,
        'QR_NOT_FOUND',
        msg('errors.scanCodeRequestDoesNotExist'),
      );
    return this.expire(row);
  }

  async status(id: string, secret: string) {
    return this.dto(await this.browser(id, secret));
  }

  async resolve(scene: string, code: string) {
    const initial = await this.database.qrRequest.findUnique({
      where: { sceneHash: hashSecret(scene) },
    });
    if (!initial)
      throw new AppError(
        404,
        'QR_NOT_FOUND',
        msg('errors.scanCodeRequestDoesNotExist'),
      );
    const row = await this.expire(initial);
    this.requireState(row, ['pending', 'scanned']);
    const identity = await this.wechat.exchangeCode(code);
    if (row.purpose === 'reauth') {
      const own = await this.database.wechatIdentity.findFirst({
        where: {
          userId: row.initiatorUserId ?? '',
          appId: identity.appId,
          openid: identity.openid,
        },
      });
      if (!own)
        throw new AppError(
          409,
          'QR_SCANNER_CONFLICT',
          msg('errors.pleaseUseTheWechatAccountBoundTo'),
        );
    }
    const scanner = await this.database.wechatIdentity.findUnique({
      where: {
        appId_openid: { appId: identity.appId, openid: identity.openid },
      },
      include: { user: true },
    });
    const scannerProof = randomSecret();
    const updated = await this.database.qrRequest.updateMany({
      where: {
        id: row.id,
        expiresAt: { gt: this.clock.now() },
        OR: [
          { status: 'pending' },
          {
            status: 'scanned',
            scannerAppId: identity.appId,
            scannerOpenid: identity.openid,
          },
        ],
      },
      data: {
        status: 'scanned',
        ...(row.purpose === 'login'
          ? {}
          : {
              actionContext: identityJson({
                ...this.action(row),
                scannerUserId: scanner?.userId ?? null,
                scannerEpoch: scanner?.user.authEpoch ?? null,
              }),
            }),
        scannerAppId: identity.appId,
        scannerOpenid: identity.openid,
        scannerUnionid: identity.unionid ?? null,
        scannerSecretHash: hashSecret(scannerProof),
      },
    });
    if (updated.count !== 1)
      throw new AppError(
        409,
        'QR_SCANNER_CONFLICT',
        msg('errors.thisRequestHasBeenConfirmedByOther'),
      );
    return { ...this.dto({ ...row, status: 'scanned' }), scannerProof };
  }

  private requireState(row: QrRequest, allowed: string[]) {
    if (row.status === 'expired')
      throw new AppError(
        410,
        'QR_EXPIRED',
        msg('errors.theQrCodeHasExpiredPleaseRegenerate'),
      );
    if (!allowed.includes(row.status))
      throw new AppError(
        409,
        'QR_STATE_CONFLICT',
        msg('errors.theStatusOfTheScanCodeRequest'),
      );
    this.dto(row);
  }

  async confirm(id: string, scannerProof: string) {
    const initial = await this.database.qrRequest.findUnique({ where: { id } });
    if (initial && initial.purpose !== 'login')
      return this.confirmAction(initial, scannerProof);
    return this.transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM qr_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await transaction.qrRequest.findFirst({
        where: { id, scannerSecretHash: hashSecret(scannerProof) },
      });
      if (!row)
        throw new AppError(
          404,
          'QR_NOT_FOUND',
          msg('errors.theScanCodeConfirmationCredentialsAreInvalid'),
        );
      this.requireState(
        row.expiresAt.getTime() <= this.clock.now().getTime()
          ? { ...row, status: 'expired' }
          : row,
        ['scanned'],
      );
      if (!row.scannerAppId || !row.scannerOpenid)
        throw new AppError(
          409,
          'QR_STATE_CONFLICT',
          msg('errors.pleaseScanTheCodeAgain'),
        );
      const userId = await this.identities.findOrCreateInTransaction(
        {
          appId: row.scannerAppId,
          openid: row.scannerOpenid,
          ...(row.scannerUnionid ? { unionid: row.scannerUnionid } : {}),
        },
        transaction,
      );
      const updated = await transaction.qrRequest.updateMany({
        where: {
          id,
          status: 'scanned',
          scannerSecretHash: hashSecret(scannerProof),
          expiresAt: { gt: this.clock.now() },
        },
        data: { status: 'confirmed', confirmedUserId: userId },
      });
      if (updated.count !== 1)
        throw new AppError(
          409,
          'QR_STATE_CONFLICT',
          msg('errors.theStatusOfTheScanCodeRequest'),
        );
      return this.dto({ ...row, status: 'confirmed' });
    });
  }

  async consume(id: string, secret: string) {
    const row = await this.browser(id, secret);
    this.requireState(row, ['confirmed']);
    if (!row.confirmedUserId)
      throw new AppError(
        409,
        'QR_STATE_CONFLICT',
        msg('errors.pleaseScanTheCodeAgain'),
      );
    // Consume first: session adapter failure burns this right, never restores confirmed.
    const updated = await this.database.qrRequest.updateMany({
      where: {
        id,
        status: 'confirmed',
        browserSecretHash: hashSecret(secret),
        expiresAt: { gt: this.clock.now() },
      },
      data: { status: 'consumed', scannerOpenid: null, scannerUnionid: null },
    });
    if (updated.count !== 1)
      throw new AppError(
        409,
        'QR_STATE_CONFLICT',
        msg('errors.theScanCodeRequestHasBeenReceived'),
      );
    return row.confirmedUserId;
  }

  private action(row: QrRequest) {
    return z
      .object({
        purpose: z.enum([
          'bind_email',
          'bind_wechat',
          'merge',
          'delete_account',
          'cancel_deletion',
          'recover_drafts',
        ]),
        operationId: z.uuid(),
        target: z.string(),
        proofExpiresAt: z.iso.datetime().optional(),
        scannerUserId: z.uuid().nullable().optional(),
        scannerEpoch: z.number().nullable().optional(),
      })
      .parse(row.actionContext);
  }
  private actor(row: QrRequest): Actor {
    if (
      !row.initiatorUserId ||
      !row.initiatorSessionId ||
      !row.initiatorAuthEpoch
    )
      throw new AppError(
        403,
        'REAUTH_REQUIRED',
        msg('errors.pleaseRestartAuthentication'),
      );
    return {
      userId: row.initiatorUserId,
      sessionId: row.initiatorSessionId,
      authEpoch: row.initiatorAuthEpoch,
      transport: 'cookie',
    };
  }
  private async createAction(
    id: string,
    purpose: string,
    actor?: Actor,
    action?: ActionRequest & { proof?: string | undefined },
  ) {
    if (!actor || !action || !['reauth', 'bind_wechat'].includes(purpose))
      throw new AppError(
        403,
        'REAUTH_REQUIRED',
        msg('errors.pleaseLogInAndReVerify'),
      );
    let proofExpiresAt: string | undefined;
    if (purpose === 'bind_wechat') {
      if (action.purpose !== 'bind_wechat' || action.target !== 'wechat')
        throw new AppError(
          403,
          'REAUTH_REQUIRED',
          msg('errors.bindOperationProvedMismatch'),
        );
      const c = await this.proofs.verify(action.proof ?? '', actor, action);
      proofExpiresAt = new Date(c.exp * 1000).toISOString();
    }
    const scene = randomBytes(24).toString('base64url'),
      secret = randomSecret();
    const miniappCode = await this.wechat.createMiniappCode(scene);
    const row = await this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
      const user = await this.proofs.current(tx, actor, purpose === 'reauth');
      this.proofs.assertPurpose(user.status, action);
      return tx.qrRequest.create({
        data: {
          id,
          purpose,
          browserSecretHash: hashSecret(secret),
          sceneHash: hashSecret(scene),
          expiresAt: new Date(this.clock.now().getTime() + 120000),
          initiatorUserId: actor.userId,
          initiatorSessionId: actor.sessionId,
          initiatorAuthEpoch: actor.authEpoch,
          actionContext: identityJson({
            purpose: action.purpose,
            operationId: action.operationId,
            target: action.target,
            ...(proofExpiresAt ? { proofExpiresAt } : {}),
          }),
        },
      });
    });
    return { data: { ...this.dto(row), miniappCode }, secret };
  }
  private async confirmAction(initial: QrRequest, scannerProof: string) {
    return this.transaction(async (tx) => {
      const actor = this.actor(initial),
        action = this.action(initial);
      const ids = [
        ...new Set([
          actor.userId,
          ...(action.scannerUserId ? [action.scannerUserId] : []),
        ]),
      ].sort();
      for (const uid of ids)
        await tx.$queryRaw`SELECT id FROM users WHERE id=${uid}::uuid FOR UPDATE`;
      try {
        await this.proofs.current(tx, actor, initial.purpose === 'reauth');
      } catch (error) {
        if (error instanceof AppError && error.getStatus() === 401)
          throw new AppError(
            409,
            'PREVIEW_STALE',
            msg('errors.theWebSessionInitiatedHasExpiredPlease'),
          );
        throw error;
      }

      await tx.$queryRaw`SELECT id FROM qr_requests WHERE id=${initial.id}::uuid FOR UPDATE`;
      const row = await tx.qrRequest.findFirst({
        where: { id: initial.id, scannerSecretHash: hashSecret(scannerProof) },
      });
      if (!row)
        throw new AppError(
          404,
          'QR_NOT_FOUND',
          msg('errors.theScanCodeConfirmationCredentialsAreInvalid2'),
        );
      this.requireState(
        row.expiresAt <= this.clock.now() ? { ...row, status: 'expired' } : row,
        ['scanned'],
      );
      if (
        row.purpose === 'bind_wechat' &&
        (!action.proofExpiresAt ||
          Date.parse(action.proofExpiresAt) <= this.clock.now().getTime())
      )
        throw new AppError(
          403,
          'REAUTH_REQUIRED',
          msg('errors.theWebPageNeedsToReVerify'),
        );
      if (action.scannerUserId) {
        const scanner = await tx.user.findUnique({
          where: { id: action.scannerUserId },
        });
        if (
          !scanner ||
          scanner.authEpoch !== action.scannerEpoch ||
          (scanner.status !== 'active' && row.purpose !== 'reauth')
        )
          throw new AppError(
            409,
            'PREVIEW_STALE',
            msg('errors.theIdentityOfTheScannedAccountHas'),
          );
      }
      if (row.purpose === 'reauth' && action.scannerUserId !== actor.userId)
        throw new AppError(
          409,
          'QR_SCANNER_CONFLICT',
          msg('errors.theScannerDoesNotMatchTheCurrent'),
        );
      await tx.qrRequest.update({
        where: { id: row.id },
        data: { status: 'confirmed' },
      });
      return this.dto({ ...row, status: 'confirmed' });
    });
  }
  async consumeAction(id: string, secret: string, actor: Actor) {
    const initial = await this.browser(id, secret),
      action = this.action(initial);
    return this.transaction(async (tx) => {
      const expected = this.actor(initial);
      if (
        expected.userId !== actor.userId ||
        expected.sessionId !== actor.sessionId ||
        expected.authEpoch !== actor.authEpoch
      )
        throw new AppError(
          403,
          'REAUTH_REQUIRED',
          msg('errors.pleaseReturnToTheOriginalSessionWhere'),
        );
      const ids = [
        ...new Set([
          actor.userId,
          ...(action.scannerUserId ? [action.scannerUserId] : []),
        ]),
      ].sort();
      for (const uid of ids)
        await tx.$queryRaw`SELECT id FROM users WHERE id=${uid}::uuid FOR UPDATE`;
      await this.proofs.current(tx, actor, initial.purpose === 'reauth');
      await tx.$queryRaw`SELECT id FROM qr_requests WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.qrRequest.findUniqueOrThrow({ where: { id } });
      this.requireState(
        row.expiresAt <= this.clock.now() ? { ...row, status: 'expired' } : row,
        ['confirmed'],
      );
      if (row.purpose === 'reauth') {
        if (
          action.scannerUserId !== actor.userId ||
          action.scannerEpoch !== actor.authEpoch
        )
          throw new AppError(
            409,
            'QR_SCANNER_CONFLICT',
            msg('errors.scanningIdentityDoesNotMatch'),
          );
        const result = await this.proofs.issue(actor, action);
        await tx.qrRequest.update({
          where: { id },
          data: {
            status: 'consumed',
            scannerSecretHash: null,
            scannerOpenid: null,
            scannerUnionid: null,
          },
        });
        return result;
      }
      if (
        !action.proofExpiresAt ||
        Date.parse(action.proofExpiresAt) <= this.clock.now().getTime() ||
        !row.scannerAppId ||
        !row.scannerOpenid
      )
        throw new AppError(
          403,
          'REAUTH_REQUIRED',
          msg('errors.thisOperationRequiresReVerification'),
        );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.scannerAppId + ':' + row.scannerOpenid}))`;
      const identity = await tx.wechatIdentity.findUnique({
        where: {
          appId_openid: { appId: row.scannerAppId, openid: row.scannerOpenid },
        },
        include: { user: true },
      });
      if (
        (identity?.userId ?? null) !== (action.scannerUserId ?? null) ||
        (identity && identity.user.authEpoch !== action.scannerEpoch)
      )
        throw new AppError(
          409,
          'PREVIEW_STALE',
          msg('errors.theWechatAssociationHasChangedPleaseScan'),
        );
      let result;
      if (identity && identity.userId !== actor.userId) {
        result = await this.identity.grant(
          tx,
          actor,
          identity.userId,
          action.operationId,
          new Date(
            Math.min(
              Date.parse(action.proofExpiresAt),
              this.clock.now().getTime() + 300000,
            ),
          ),
        );
      } else {
        if (!identity) {
          const existing = await tx.wechatIdentity.count({
            where: { userId: actor.userId, appId: row.scannerAppId },
          });
          if (existing)
            throw new AppError(
              409,
              'IDENTITY_COMBINATION_UNSUPPORTED',
              msg('errors.thisAccountAlreadyHasWechatAndCannot'),
            );
          await tx.wechatIdentity.create({
            data: {
              userId: actor.userId,
              appId: row.scannerAppId,
              openid: row.scannerOpenid,
              unionid: row.scannerUnionid,
            },
          });
          await tx.user.update({
            where: { id: actor.userId },
            data: { authEpoch: { increment: 1 } },
          });
          await tx.session.deleteMany({ where: { userId: actor.userId } });
        }
        result = { status: 'bound' as const, reauthenticate: !identity };
      }
      await tx.qrRequest.update({
        where: { id },
        data: {
          status: 'consumed',
          result: identityJson(result),
          scannerOpenid: null,
          scannerUnionid: null,
          scannerSecretHash: null,
        },
      });
      return result;
    });
  }
  async cancel(id: string, browserSecret: string, scannerProof?: string) {
    const initial = await this.database.qrRequest.findFirst({
      where: {
        id,
        OR: [
          ...(browserSecret
            ? [{ browserSecretHash: hashSecret(browserSecret) }]
            : []),
          ...(scannerProof
            ? [{ scannerSecretHash: hashSecret(scannerProof) }]
            : []),
        ],
      },
    });
    if (!initial)
      throw new AppError(
        404,
        'QR_NOT_FOUND',
        msg('errors.scanCodeRequestDoesNotExist'),
      );
    const row = await this.expire(initial);
    this.requireState(row, ['pending', 'scanned', 'confirmed', 'cancelled']);
    if (row.status !== 'cancelled') {
      const updated = await this.database.qrRequest.updateMany({
        where: {
          id,
          status: { in: ['pending', 'scanned', 'confirmed'] },
          expiresAt: { gt: this.clock.now() },
        },
        data: {
          status: 'cancelled',
          scannerOpenid: null,
          scannerUnionid: null,
          scannerSecretHash: null,
        },
      });
      if (updated.count !== 1)
        throw new AppError(
          409,
          'QR_STATE_CONFLICT',
          msg('errors.theScanCodeRequestHasBeenReceived'),
        );
    }
    return this.dto({ ...row, status: 'cancelled' });
  }
}

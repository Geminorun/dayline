import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { QR_STATUSES } from '@dayline/contracts';
import type { QrStatusDto } from '@dayline/contracts';
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
    @Inject(PrismaService) private readonly database: PrismaService,
    @Inject(WECHAT_ADAPTER) private readonly wechat: WechatAdapter,
    @Inject(WechatService) private readonly identities: WechatService,
  ) {}

  async create(id: string, purpose: string) {
    if (purpose !== 'login')
      throw new AppError(
        409,
        'QR_PURPOSE_UNAVAILABLE',
        '微信绑定将在账号绑定阶段开放。',
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
          expiresAt: new Date(Date.now() + 120_000),
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
          '请求已创建，请生成新的扫码请求。',
        );
      throw error;
    }
    return { data: { ...this.dto(row), miniappCode }, secret };
  }

  private dto(row: QrRequest): QrStatusDto {
    if (row.purpose !== 'login')
      throw new AppError(409, 'QR_PURPOSE_UNAVAILABLE', '此扫码用途尚未开放。');
    return {
      id: row.id,
      purpose: 'login',
      status: z.enum(QR_STATUSES).parse(row.status),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private async expire(row: QrRequest) {
    if (
      row.expiresAt.getTime() <= Date.now() &&
      ['pending', 'scanned', 'confirmed'].includes(row.status)
    ) {
      await this.database.qrRequest.updateMany({
        where: {
          id: row.id,
          status: { in: ['pending', 'scanned', 'confirmed'] },
          expiresAt: { lte: new Date() },
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
      throw new AppError(404, 'QR_NOT_FOUND', '扫码请求不存在。');
    return this.expire(row);
  }

  async status(id: string, secret: string) {
    return this.dto(await this.browser(id, secret));
  }

  async resolve(scene: string, code: string) {
    const initial = await this.database.qrRequest.findUnique({
      where: { sceneHash: hashSecret(scene) },
    });
    if (!initial) throw new AppError(404, 'QR_NOT_FOUND', '扫码请求不存在。');
    const row = await this.expire(initial);
    this.requireState(row, ['pending', 'scanned']);
    const identity = await this.wechat.exchangeCode(code);
    const scannerProof = randomSecret();
    const updated = await this.database.qrRequest.updateMany({
      where: {
        id: row.id,
        expiresAt: { gt: new Date() },
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
        '此请求已被其他微信确认或状态已变化，请重新扫码。',
      );
    return { ...this.dto({ ...row, status: 'scanned' }), scannerProof };
  }

  private requireState(row: QrRequest, allowed: string[]) {
    if (row.status === 'expired')
      throw new AppError(410, 'QR_EXPIRED', '二维码已过期，请重新生成。');
    if (!allowed.includes(row.status))
      throw new AppError(409, 'QR_STATE_CONFLICT', '扫码请求状态已变化。');
    this.dto(row);
  }

  async confirm(id: string, scannerProof: string) {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM qr_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await transaction.qrRequest.findFirst({
        where: { id, scannerSecretHash: hashSecret(scannerProof) },
      });
      if (!row) throw new AppError(404, 'QR_NOT_FOUND', '扫码确认凭据无效。');
      this.requireState(
        row.expiresAt.getTime() <= Date.now()
          ? { ...row, status: 'expired' }
          : row,
        ['scanned'],
      );
      if (!row.scannerAppId || !row.scannerOpenid)
        throw new AppError(409, 'QR_STATE_CONFLICT', '请重新扫码。');
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
          expiresAt: { gt: new Date() },
        },
        data: { status: 'confirmed', confirmedUserId: userId },
      });
      if (updated.count !== 1)
        throw new AppError(409, 'QR_STATE_CONFLICT', '扫码请求状态已变化。');
      return this.dto({ ...row, status: 'confirmed' });
    });
  }

  async consume(id: string, secret: string) {
    const row = await this.browser(id, secret);
    this.requireState(row, ['confirmed']);
    if (!row.confirmedUserId)
      throw new AppError(409, 'QR_STATE_CONFLICT', '请重新扫码。');
    // Consume first: session adapter failure burns this right, never restores confirmed.
    const updated = await this.database.qrRequest.updateMany({
      where: {
        id,
        status: 'confirmed',
        browserSecretHash: hashSecret(secret),
        expiresAt: { gt: new Date() },
      },
      data: { status: 'consumed', scannerOpenid: null, scannerUnionid: null },
    });
    if (updated.count !== 1)
      throw new AppError(409, 'QR_STATE_CONFLICT', '扫码请求已领取或失效。');
    return row.confirmedUserId;
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
    if (!initial) throw new AppError(404, 'QR_NOT_FOUND', '扫码请求不存在。');
    const row = await this.expire(initial);
    this.requireState(row, ['pending', 'scanned', 'confirmed', 'cancelled']);
    if (row.status !== 'cancelled') {
      const updated = await this.database.qrRequest.updateMany({
        where: {
          id,
          status: { in: ['pending', 'scanned', 'confirmed'] },
          expiresAt: { gt: new Date() },
        },
        data: {
          status: 'cancelled',
          scannerOpenid: null,
          scannerUnionid: null,
          scannerSecretHash: null,
        },
      });
      if (updated.count !== 1)
        throw new AppError(409, 'QR_STATE_CONFLICT', '扫码请求已领取或失效。');
    }
    return this.dto({ ...row, status: 'cancelled' });
  }
}

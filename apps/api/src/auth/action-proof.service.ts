import { Clock } from '../records/clock.js';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { ActionRequest } from '@dayline/contracts';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
const claims = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  epoch: z.number().int(),
  purpose: z.string(),
  operationId: z.uuid(),
  target: z.string(),
  exp: z.number(),
});
@Injectable()
export class ActionProofService {
  private readonly key: Uint8Array;
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = new TextEncoder().encode(config.actionProofSecret);
  }
  async issue(actor: Actor, action: ActionRequest) {
    const exp = Math.floor(this.clock.now().getTime() / 1000) + 300;
    const proof = await new SignJWT({
      sid: actor.sessionId,
      epoch: actor.authEpoch,
      purpose: action.purpose,
      operationId: action.operationId,
      target: action.target,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'dayline-action+jwt' })
      .setSubject(actor.userId)
      .setIssuer('dayline-action')
      .setAudience('dayline-sensitive-operation')
      .setIssuedAt(Math.floor(this.clock.now().getTime() / 1000))
      .setExpirationTime(exp)
      .sign(this.key);
    return { proof, expiresAt: new Date(exp * 1000).toISOString() };
  }
  async verify(proof: string, actor: Actor, action: ActionRequest) {
    try {
      const result = await jwtVerify(proof, this.key, {
        algorithms: ['HS256'],
        typ: 'dayline-action+jwt',
        issuer: 'dayline-action',
        audience: 'dayline-sensitive-operation',
        currentDate: this.clock.now(),
      });
      const c = claims.parse(result.payload);
      if (
        c.sub !== actor.userId ||
        c.sid !== actor.sessionId ||
        c.epoch !== actor.authEpoch ||
        c.purpose !== action.purpose ||
        c.operationId !== action.operationId ||
        c.target !== action.target
      )
        throw new Error('proof context');
      return c;
    } catch {
      throw new AppError(403, 'REAUTH_REQUIRED', '请为本次操作重新验证身份。');
    }
  }
  async current(
    tx: Prisma.TransactionClient,
    actor: Actor,
    allowPending = false,
  ) {
    const [user, session] = await Promise.all([
      tx.user.findUnique({ where: { id: actor.userId } }),
      tx.session.findFirst({
        where: {
          id: actor.sessionId,
          userId: actor.userId,
          authEpoch: actor.authEpoch,
          expiresAt: { gt: this.clock.now() },
        },
      }),
    ]);
    if (
      !user ||
      !session ||
      user.authEpoch !== actor.authEpoch ||
      user.status === 'merged'
    )
      throw new AppError(401, 'SESSION_REVOKED', '请重新登录。');
    if (!allowPending && user.status !== 'active')
      throw new AppError(403, 'ACCOUNT_PENDING_DELETION', '账号正在注销中。');
    return user;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { EXPECTED_USER_HEADER } from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import type { Actor } from '../common/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import { AUTH_INSTANCE } from './create-auth.js';
import type { DaylineAuth } from './create-auth.js';

interface AuthenticatedSession {
  actor: Actor;
  status: string;
  responseHeaders: Headers;
}

@Injectable()
export class AuthAccessService {
  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: DaylineAuth,
    @Inject(PrismaService) private readonly database: PrismaService,
  ) {}

  async resolve(headers: Headers): Promise<AuthenticatedSession | null> {
    const hasBearer = headers.has('authorization');
    const hasSessionCookie =
      /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(
        headers.get('cookie') ?? '',
      );
    const effectiveHeaders = new Headers(headers);
    if (hasBearer && hasSessionCookie) effectiveHeaders.delete('cookie');
    const result = await this.auth.api.getSession({
      headers: effectiveHeaders,
      returnHeaders: true,
    });
    const session = result.response;
    if (hasBearer && hasSessionCookie) {
      const cookieHeaders = new Headers(headers);
      cookieHeaders.delete('authorization');
      const cookieSession = await this.auth.api.getSession({
        headers: cookieHeaders,
        query: { disableRefresh: true },
      });
      if (
        !cookieSession ||
        !session ||
        cookieSession.user.id !== session.user.id
      ) {
        throw new AppError(
          401,
          'UNAUTHENTICATED',
          '登录凭据不一致，请重新登录。',
        );
      }
    }
    if (!session) return null;
    const user = await this.database.user.findUnique({
      where: { id: session.user.id },
    });
    if (
      !user ||
      user.status === 'merged' ||
      user.authEpoch !== session.session.authEpoch
    ) {
      throw new AppError(
        401,
        'SESSION_REVOKED',
        '登录状态已失效，请重新登录。',
      );
    }
    if (
      session.session.authMethod === 'email_password' &&
      (!user.emailVerified || user.emailKind !== 'real')
    ) {
      throw new AppError(401, 'UNAUTHENTICATED', '请先完成邮箱验证。');
    }
    return {
      actor: {
        userId: user.id,
        sessionId: session.session.id,
        authEpoch: user.authEpoch,
        transport: hasBearer ? 'bearer' : 'cookie',
      },
      status: user.status,
      responseHeaders: result.headers,
    };
  }

  async require(
    headers: Headers,
    method: string,
    allowPending = false,
  ): Promise<AuthenticatedSession> {
    const result = await this.resolve(headers);
    if (!result) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    const expectedUser = headers.get(EXPECTED_USER_HEADER);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !expectedUser) {
      throw new AppError(400, 'ACTOR_CONTEXT_REQUIRED', '请求缺少账号上下文。');
    }
    if (expectedUser && expectedUser !== result.actor.userId) {
      throw new AppError(
        409,
        'ACTOR_CONTEXT_MISMATCH',
        '当前账号已变化，请重新确认。',
      );
    }
    if (result.status === 'pending_deletion' && !allowPending) {
      throw new AppError(403, 'ACCOUNT_PENDING_DELETION', '账号正在注销中。');
    }
    return result;
  }
}

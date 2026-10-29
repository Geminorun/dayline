import { msg } from '@dayline/locales';
import { Clock } from '../records/clock.js';
import { Inject, Injectable } from '@nestjs/common';
import { EXPECTED_USER_HEADER } from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import type { Actor } from '../common/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthAdapter } from './adapter/auth-adapter.js';

interface AuthenticatedSession {
  actor: Actor;
  status: string;
  internalIdentity: boolean;
  responseHeaders: Headers;
}

@Injectable()
export class AuthAccessService {
  constructor(
    @Inject(Clock) private readonly clock: Clock,
    @Inject(AuthAdapter) private readonly auth: AuthAdapter,
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
    const result = await this.auth.readSession(effectiveHeaders);
    const session = result.response;
    if (hasBearer && hasSessionCookie) {
      const cookieHeaders = new Headers(headers);
      cookieHeaders.delete('authorization');
      const { response: cookieSession } = await this.auth.readSession(
        cookieHeaders,
        true,
      );
      if (
        !cookieSession ||
        !session ||
        cookieSession.user.id !== session.user.id
      ) {
        throw new AppError(
          401,
          'UNAUTHENTICATED',
          msg('errors.loginCredentialsAreInconsistentPleaseLogIn'),
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
      (user.status === 'pending_deletion' &&
        user.deletionDueAt !== null &&
        user.deletionDueAt <= this.clock.now()) ||
      user.authEpoch !== session.session.authEpoch
    ) {
      throw new AppError(
        401,
        'SESSION_REVOKED',
        msg('errors.loginStatusHasExpiredPleaseLogIn'),
      );
    }
    if (
      session.session.authMethod === 'email_password' &&
      (!user.emailVerified || user.emailKind !== 'real')
    ) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        msg('errors.pleaseCompleteEmailVerificationFirst'),
      );
    }
    return {
      actor: {
        userId: user.id,
        sessionId: session.session.id,
        authEpoch: user.authEpoch,
        transport: hasBearer ? 'bearer' : 'cookie',
      },
      status: user.status,
      internalIdentity: user.emailKind === 'internal',
      responseHeaders: result.headers,
    };
  }

  async require(
    headers: Headers,
    method: string,
    allowPending = false,
  ): Promise<AuthenticatedSession> {
    const result = await this.resolve(headers);
    if (!result)
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        msg('errors.pleaseLogInFirst'),
      );
    const expectedUser = headers.get(EXPECTED_USER_HEADER);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !expectedUser) {
      throw new AppError(
        400,
        'ACTOR_CONTEXT_REQUIRED',
        msg('errors.theRequestIsMissingAccountContext'),
      );
    }
    if (expectedUser && expectedUser !== result.actor.userId) {
      throw new AppError(
        409,
        'ACTOR_CONTEXT_MISMATCH',
        msg('errors.theCurrentAccountHasChangedPleaseReconfirm'),
      );
    }
    if (result.status === 'pending_deletion' && !allowPending) {
      throw new AppError(
        403,
        'ACCOUNT_PENDING_DELETION',
        msg('errors.accountDeletionIsPending'),
      );
    }
    return result;
  }
}

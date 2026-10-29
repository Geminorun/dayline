import { msg } from '@dayline/locales';
import { serverText } from '../i18n/server-text.js';
import { requestBudget } from '../common/request-budget.js';
import { Logger } from '@nestjs/common';
import { errorDiagnostics } from '../common/error-diagnostics.js';
import type { SecurityService } from '../security/security.service.js';
import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { AppError } from '../common/app-error.js';
import type { AuthAccessService } from './auth-access.service.js';
import { forwardSessionHeaders } from './session-headers.js';

const anonymousPaths = new Set([
  '/sign-up/email',
  '/send-verification-email',
  '/verify-email',
  '/sign-in/email',
  '/request-password-reset',
  '/reset-password',
]);
const sessionPaths = new Set(['/change-password', '/sign-out']);

export function nativeAuthPolicy(
  access: AuthAccessService,
  security: SecurityService,
) {
  const logger = new Logger('Authentication');
  function reportFailure(cause: unknown) {
    if (!(cause instanceof AppError) || cause.getStatus() >= 500)
      logger.error({ code: 'AUTH_UNAVAILABLE', ...errorDiagnostics(cause) });
  }
  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Replace, never trust a client supplied internal IP header.
    request.headers['x-dayline-internal-ip'] = request.ip ?? 'unknown';
    const scope = requestBudget.getStore(),
      ip = request.ip ?? 'unknown';
    response.on('finish', () => {
      if (
        scope?.authPath === '/sign-in/email' &&
        [401, 403].includes(response.statusCode) &&
        scope.authEmail
      )
        security.failure('password', ip, scope.authEmail);
    });
    const path = new URL(request.originalUrl, 'http://localhost').pathname
      .slice('/api/auth'.length)
      .replace(/\/$/, '');
    try {
      security.native(request, response);
    } catch (error) {
      reportFailure(error);
      if (error instanceof AppError)
        response.status(error.getStatus()).json({
          code: error.code,
          message: serverText(error.localized ?? error.message),
        });
      else
        response.status(503).json({
          code: 'AUTH_UNAVAILABLE',
          message: serverText(
            msg('errors.theAuthenticationServiceIsTemporarilyUnavailable'),
          ),
        });
      return;
    }
    if (
      anonymousPaths.has(path) ||
      (request.method === 'GET' && /^\/reset-password\/[^/]+$/.test(path))
    ) {
      next();
      return;
    }
    try {
      if (path === '/get-session') {
        const session = await access.resolve(fromNodeHeaders(request.headers));
        if (session?.internalIdentity)
          throw new AppError(
            403,
            'USE_PUBLIC_PROFILE',
            msg('errors.pleaseUseThePublicAccountInterfaceFor'),
          );
        if (session) forwardSessionHeaders(response, session.responseHeaders);
      } else if (sessionPaths.has(path)) {
        const session = await access.require(
          fromNodeHeaders(request.headers),
          request.method,
          path === '/sign-out',
        );
        forwardSessionHeaders(response, session.responseHeaders);
      } else {
        response.status(404).json({
          code: 'NOT_FOUND',
          message: serverText(
            msg('errors.thisAuthenticationOperationIsNotYetOpen'),
          ),
        });
        return;
      }
      next();
    } catch (error) {
      reportFailure(error);
      if (error instanceof AppError) {
        response.status(error.getStatus()).json({
          code: error.code,
          message: serverText(error.localized ?? error.message),
        });
      } else {
        response.status(503).json({
          code: 'AUTH_UNAVAILABLE',
          message: serverText(
            msg('errors.theAuthenticationServiceIsTemporarilyUnavailable'),
          ),
        });
      }
    }
  };
}

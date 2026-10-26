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

export function nativeAuthPolicy(access: AuthAccessService) {
  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const path = new URL(request.originalUrl, 'http://localhost').pathname
      .slice('/api/auth'.length)
      .replace(/\/$/, '');
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
        if (session) forwardSessionHeaders(response, session.responseHeaders);
      } else if (sessionPaths.has(path)) {
        const session = await access.require(
          fromNodeHeaders(request.headers),
          request.method,
          path === '/sign-out',
        );
        forwardSessionHeaders(response, session.responseHeaders);
      } else {
        response
          .status(404)
          .json({ code: 'NOT_FOUND', message: '此认证操作尚未开放。' });
        return;
      }
      next();
    } catch (error) {
      if (error instanceof AppError) {
        response
          .status(error.getStatus())
          .json({ code: error.code, message: error.message });
      } else {
        response
          .status(503)
          .json({ code: 'AUTH_UNAVAILABLE', message: '认证服务暂时不可用。' });
      }
    }
  };
}

import { Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from '../config/environment.js';
import { requestBudget } from './request-budget.js';

export function requestLogging(
  config: Pick<
    AppConfig,
    'environment' | 'batchTimeoutMs' | 'requestTimeoutMs'
  >,
) {
  const logger = new Logger('HTTP');
  return (request: Request, response: Response, next: NextFunction) => {
    const batch =
      /^\/api\/v1\/(?:imports|guest-admissions|account-merges)(?:\/|$)/.test(
        request.path,
      );
    const timeout = batch ? config.batchTimeoutMs : config.requestTimeoutMs;
    const started = performance.now();
    response.on('finish', () => {
      if (config.environment === 'test') return;
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        /^\/health\/(?:live|ready)\/?$/.test(request.path) &&
        response.statusCode >= 200 &&
        response.statusCode < 300
      )
        return;
      const event = {
        code: 'HTTP_REQUEST',
        requestId: request.requestId,
        method: request.method,
        route: requestLogRoute(request),
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      };
      if (response.statusCode >= 500) logger.error(event);
      else if (response.statusCode >= 400) logger.warn(event);
      else logger.log(event);
    });
    // The callback preserves the transaction's completion; no early timeout response.
    requestBudget.run(
      { requestId: request.requestId, deadline: Date.now() + timeout },
      next,
    );
  };
}

export function requestLogRoute(request: Request): string {
  if (request.path.startsWith('/api/auth')) {
    const operation =
      /^\/api\/auth\/(sign-in\/email|sign-up\/email|send-verification-email|request-password-reset|reset-password|verify-email|change-password|sign-out|get-session)\/?$/.exec(
        request.path,
      )?.[1];
    return operation ? `/api/auth/${operation}` : '/api/auth/:operation';
  }
  const route: unknown = request.route?.path;
  return typeof route === 'string' ? route : 'unmatched';
}

import { SecurityService } from '../security/security.service.js';
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { ALLOW_PENDING_DELETION, IS_PUBLIC } from './auth.decorators.js';
import { AuthAccessService } from './auth-access.service.js';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { AppError } from '../common/app-error.js';
import { forwardSessionHeaders } from './session-headers.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthAccessService) private readonly access: AuthAccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      this.security.business(request, response);
      return true;
    }
    const allowPending =
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_PENDING_DELETION,
        targets,
      ) ?? false;
    const session = await this.access.require(
      fromNodeHeaders(request.headers),
      request.method,
      allowPending,
    );
    request.actor = session.actor;
    this.security.business(request, response);
    if (
      request.actor.transport === 'cookie' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      if (
        !request.headers.origin ||
        !this.config.trustedOrigins.includes(request.headers.origin)
      ) {
        throw new AppError(403, 'UNTRUSTED_ORIGIN', '请求来源未被允许。');
      }
    }
    forwardSessionHeaders(
      context.switchToHttp().getResponse<Response>(),
      session.responseHeaders,
    );
    return true;
  }
}

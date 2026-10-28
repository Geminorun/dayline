import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { AppError } from '../common/app-error.js';
@Injectable()
export class SecurityService {
  private readonly buckets = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  consume(
    scope: string,
    identity: string,
    max: number,
    window = 60000,
    response?: Response,
  ) {
    const key = createHash('sha256')
        .update(scope + ':' + identity)
        .digest('hex'),
      now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 20000) {
        for (const [k, v] of this.buckets)
          if (v.until <= now) this.buckets.delete(k);
        if (this.buckets.size >= 20000) {
          response?.setHeader('Retry-After', '60');
          throw new AppError(429, 'RATE_LIMITED', '请求较多，请稍后重试。');
        }
      }
      bucket = { count: 0, until: now + window };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.until - now) / 1000),
      );
      response?.setHeader('Retry-After', String(retryAfterSeconds));
      throw new AppError(
        429,
        'RATE_LIMITED',
        '操作过于频繁，请按提示稍后重试。',
        { retryAfterSeconds },
      );
    }
    bucket.count++;
    return Math.max(0, Math.ceil((bucket.until - now) / 1000));
  }
  native(request: Request, response: Response) {
    if (!this.config.rateLimitEnabled) return;
    const path = request.path;
    const ip = request.ip ?? 'unknown';
    this.consume('native-ip', ip, 120, 60000, response);
    if (
      /\/(?:sign-up\/email|send-verification-email|request-password-reset)$/.test(
        path,
      )
    )
      this.consume('mail-ip', ip, 20, 60000, response);
    if (/\/sign-in\/email$/.test(path))
      this.consume('password-ip-total', ip, 60, 600000, response);
    if (/\/reset-password$/.test(path))
      this.consume('reset-ip', ip, 10, 600000, response);
  }
  private readonly failed = new Map<string, { count: number; until: number }>();
  private failureExpiry = Number.POSITIVE_INFINITY;
  private pruneFailures(now: number) {
    if (now < this.failureExpiry) return;
    this.failureExpiry = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.failed) {
      if (value.until <= now) this.failed.delete(key);
      else this.failureExpiry = Math.min(this.failureExpiry, value.until);
    }
  }
  private failureKeys(scope: string, ip: string, identity: string) {
    return [
      scope + ':ip:' + ip,
      scope + ':identity-ip:' + ip + ':' + identity,
    ].map((v) => createHash('sha256').update(v).digest('hex'));
  }
  checkFailures(
    scope: string,
    ip: string,
    identity: string,
    response?: Response,
  ) {
    const keys = this.failureKeys(scope, ip, identity),
      now = Date.now();
    this.pruneFailures(now);
    if (this.failed.size >= 20000) {
      response?.setHeader('Retry-After', '600');
      throw new AppError(429, 'RATE_LIMITED', '验证请求较多，请稍后重试。');
    }
    if (
      keys.some((k, i) => {
        const value = this.failed.get(k);
        return value && value.until > now && value.count >= (i === 0 ? 30 : 5);
      })
    ) {
      response?.setHeader('Retry-After', '600');
      throw new AppError(429, 'RATE_LIMITED', '验证失败次数过多，请稍后再试。');
    }
  }
  failure(scope: string, ip: string, identity: string) {
    const now = Date.now();
    this.pruneFailures(now);
    if (this.failed.size >= 20000) return; // Bounded failure memory; request counters still fail closed at capacity.
    for (const key of this.failureKeys(scope, ip, identity)) {
      const old = this.failed.get(key);
      this.failed.set(key, {
        count: (old?.count ?? 0) + 1,
        until: old?.until ?? now + 600000,
      });
      this.failureExpiry = Math.min(
        this.failureExpiry,
        old?.until ?? now + 600000,
      );
    }
  }
  nativeIdentity(path: string, email: string, ip: string) {
    if (!this.config.rateLimitEnabled) return 0;
    const normalized = email.trim().toLowerCase();
    if (
      normalized &&
      /^\/(?:sign-up\/email|send-verification-email|request-password-reset)$/.test(
        path,
      )
    )
      return this.consume('mail-identity', normalized, 1, 60000);
    if (normalized && path === '/sign-in/email')
      this.checkFailures('password', ip, normalized);
    return 0;
  }

  business(request: Request, response: Response) {
    if (!this.config.rateLimitEnabled) return;
    const path = request.path,
      ip = request.ip ?? 'unknown';
    if (path === '/api/v1/auth/wechat/login')
      this.consume('wx-ip', ip, 30, 60000, response);
    else if (path === '/api/v1/auth/qr-requests')
      this.consume('qr-create-ip', ip, 10, 60000, response);
    else if (
      /^\/api\/v1\/auth\/qr-requests\/[0-9a-f-]+$/.test(path) &&
      request.method === 'GET'
    )
      this.consume('qr-poll', path + ':' + ip, 60, 60000, response);
    else if (path.startsWith('/api/v1/auth/qr-requests'))
      this.consume('qr-action-ip', ip, 60, 60000, response);
    if (request.actor) {
      if (path === '/api/v1/snapshot')
        this.consume(
          'snapshot-session',
          request.actor.sessionId,
          12,
          60000,
          response,
        );
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        this.consume('write-user', request.actor.userId, 120, 60000, response);
      if (path.endsWith('/auth/reauth')) {
        this.consume('reauth-ip', ip, 30, 600000, response);
        this.checkFailures('reauth', ip, request.actor.userId, response);
      }
      if (
        path === '/api/v1/imports/preview' ||
        path === '/api/v1/guest-admissions/prepare'
      )
        this.consume('import-user', request.actor.userId, 5, 60000, response);
    }
  }
}

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get, Post, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationLogger } from '../src/common/application-logger.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { AppError } from '../src/common/app-error.js';
import { errorDiagnostics } from '../src/common/error-diagnostics.js';
import { requestLogging } from '../src/common/request-logging.js';
import { requestBudget } from '../src/common/request-budget.js';

let readinessFailed = false;
class LoggingTestController {
  live() {
    return { status: 'ok' };
  }
  ready() {
    if (readinessFailed)
      throw new AppError(
        503,
        'DATABASE_UNAVAILABLE',
        'Not ready',
        undefined,
        new Error('private SQL and credentials'),
      );
    return { status: 'ok' };
  }
  async ok() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    Logger.log({ code: 'DOMAIN_EVENT' }, 'Example');
    return { status: 'ok' };
  }
  unauthorized() {
    throw new AppError(401, 'UNAUTHORIZED', 'Please log in');
  }
  boom() {
    throw new TypeError('secret@example.com SQL token=private');
  }
  email() {
    return { status: true };
  }
  reset() {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid token');
  }
}
class LoggingTestModule {}
Controller()(LoggingTestController);
Module({ controllers: [LoggingTestController] })(LoggingTestModule);
for (const [method, path] of Object.entries({
  live: 'health/live',
  ready: 'health/ready',
  ok: 'ok',
  unauthorized: 'unauthorized',
  boom: 'boom',
  email: 'api/auth/send-verification-email',
  reset: 'api/auth/reset-password/:token',
})) {
  const descriptor = Object.getOwnPropertyDescriptor(
    LoggingTestController.prototype,
    method,
  );
  if (!descriptor) throw new Error('Missing test handler');
  (method === 'email' ? Post(path) : Get(path))(
    LoggingTestController.prototype,
    method,
    descriptor,
  );
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  Logger.overrideLogger(false);
  vi.restoreAllMocks();
  readinessFailed = false;
});

function capture() {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return {
    stdout,
    stderr,
    out: () => stdout.mock.calls.map(([value]) => String(value)).join(''),
    err: () => stderr.mock.calls.map(([value]) => String(value)).join(''),
  };
}

it('formats ISO timestamps, levels, context and request IDs with safe causal stacks', () => {
  const logs = capture();
  Logger.overrideLogger(new ApplicationLogger());
  requestBudget.run(
    { deadline: Date.now() + 1000, requestId: 'test-request' },
    () => {
      Logger.log({ code: 'STARTED', token: 'private-token' }, 'Example');
      Logger.error(
        {
          code: 'FAILED',
          ...errorDiagnostics(
            new Error('SQL private-input', {
              cause: new TypeError('private-cause'),
            }),
          ),
        },
        'Example',
      );
    },
  );
  expect(logs.out()).toMatch(
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO \d+ \[Example\] requestId=test-request /,
  );
  expect(logs.out()).toContain('"token":"[REDACTED]"');
  expect(logs.err()).toContain(' ERROR ');
  expect(logs.err()).toContain('Caused by: TypeError');
  expect(logs.err()).toContain('logging.test.ts:');
  expect(logs.err()).toMatch(/\n\s+at /);
  expect(logs.out() + logs.err()).not.toMatch(/private-|SQL|Object\(/);
  Logger.error(
    'private Nest exception message',
    new Error('private stack heading').stack,
    'Framework',
  );
  expect(logs.err()).not.toMatch(/private Nest|private stack/);
  expect(logs.err()).toContain('Unhandled exception');
});

it('keeps WARN and ERROR events when INFO is disabled', () => {
  const logs = capture();
  const logger = new ApplicationLogger('warn');
  logger.log('hidden', 'Example');
  logger.warn('warning', 'Example');
  logger.error({ code: 'FAILED' }, 'Example');
  expect(logs.out()).not.toContain('hidden');
  expect(logs.out()).toContain(' WARN ');
  expect(logs.err()).toContain(' ERROR ');
});

it('bounds cyclic cause chains and retains database codes without SQL messages', () => {
  const root = Object.assign(new Error('private SQL query'), { code: 'P2021' });
  const wrapped = new AppError(
    503,
    'DATABASE_UNAVAILABLE',
    'Not ready',
    undefined,
    root,
  );
  root.cause = wrapped;
  expect(errorDiagnostics(root)).toMatchObject({
    errorType: 'Error',
    errorCode: 'P2021',
  });
  const stack = errorDiagnostics(wrapped).stack;
  expect(stack).toContain('Caused by: Error [P2021]');
  expect(stack?.match(/Caused by:/g)).toHaveLength(1);
  expect(stack).not.toContain('private SQL');
});

it('suppresses successful probes, retains failures and associates safe endpoint logs with actual requests', async () => {
  const logs = capture();
  app = await NestFactory.create<NestExpressApplication>(LoggingTestModule, {
    logger: new ApplicationLogger(),
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });
  app.use(
    requestLogging({
      environment: 'development',
      requestTimeoutMs: 15000,
      batchTimeoutMs: 60000,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  logs.stdout.mockClear();
  logs.stderr.mockClear();
  const server = app.getHttpServer();
  await request(server).get('/health/live').expect(200);
  await request(server).get('/health/ready/?token=private-probe').expect(200);
  await request(server).head('/health/ready').expect(200);
  expect(logs.out() + logs.err()).toBe('');
  const successes = await Promise.all([
    request(server).get('/ok'),
    request(server).get('/ok'),
  ]);
  for (const success of successes) {
    const id = String(success.headers['x-request-id']);
    expect(logs.out()).toContain(`requestId=${id} {"code":"DOMAIN_EVENT"}`);
    expect(logs.out()).toContain(`"requestId":"${id}"`);
  }
  await request(server).get('/unauthorized').expect(401);
  expect(logs.out()).toMatch(/WARN .*"status":401/);
  const failure = await request(server).get('/boom?token=private').expect(500);
  expect(failure.body.error.code).toBe('INTERNAL_ERROR');
  expect(JSON.stringify(failure.body)).not.toMatch(/stack|SQL|secret@example/);
  expect(logs.err()).toContain(
    `"requestId":"${String(failure.headers['x-request-id'])}"`,
  );
  expect(logs.err()).toContain('TypeError');
  expect(logs.err()).toContain('logging.test.ts:');
  readinessFailed = true;
  await request(server).get('/health/ready').expect(503);
  expect(logs.err()).toMatch(/ERROR .*"route":"\/health\/ready","status":503/);
  await request(server)
    .post('/api/auth/send-verification-email')
    .send({ email: 'private@example.com' })
    .expect(201);
  expect(logs.out()).toContain('"route":"/api/auth/send-verification-email"');
  await request(server)
    .get('/api/auth/reset-password/private-reset-token')
    .expect(400);
  expect(logs.out()).toContain('"route":"/api/auth/:operation"');
  expect(logs.out() + logs.err()).not.toMatch(/private|secret@example|SQL/);
});

import 'reflect-metadata';
import { requestBudget } from './common/request-budget.js';
import { MaintenanceService } from './maintenance/maintenance.service.js';
import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import type { WechatAdapter } from './wechat/wechat-adapter.js';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/environment.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { businessConfirmationBodyParser } from './common/business-body-parser.js';
import { ApiResultInterceptor } from './common/api-result.interceptor.js';
import { createStaticSite } from './web/static-site.js';

export async function createApp(
  config: AppConfig,
  testWechatAdapter?: WechatAdapter,
) {
  if (testWechatAdapter && config.environment !== 'test')
    throw new Error('Test adapters require NODE_ENV=test.');
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, testWechatAdapter),
    {
      bodyParser: false,
      abortOnError: false,
      logger:
        config.environment === 'test'
          ? false
          : config.logLevel === 'error'
            ? ['error']
            : config.logLevel === 'warn'
              ? ['warn', 'error']
              : ['log', 'warn', 'error'],
    },
  );
  app.set('trust proxy', config.trustProxy.length ? config.trustProxy : false);
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (!request.path.startsWith('/health/'))
      app.get(MaintenanceService).assertReady();
    next();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const methodOverride = request.get('X-Dayline-Method-Override');
    if (
      methodOverride &&
      request.method === 'POST' &&
      request.path.startsWith('/api/v1/') &&
      methodOverride === 'PATCH'
    )
      request.method = 'PATCH';
    request.requestId = randomUUID();
    response.setHeader('X-Request-ID', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    if (config.releaseRevision)
      response.setHeader('X-Dayline-Revision', config.releaseRevision);
    next();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const batch =
      /^\/api\/v1\/(?:imports(?:\/|$)|guest-admissions(?:\/|$)|account-merges(?:\/|$))/.test(
        request.path,
      );
    const timeout = batch ? config.batchTimeoutMs : config.requestTimeoutMs;
    // No res.setTimeout/Promise.race: a response is only completed after its transaction settles.
    const start = performance.now();
    response.on('finish', () => {
      if (config.environment !== 'test' && config.logLevel === 'info') {
        const route: unknown = request.route?.path;
        process.stdout.write(
          JSON.stringify({
            requestId: request.requestId,
            method: request.method,
            route:
              typeof route === 'string'
                ? route
                : request.path.startsWith('/api/auth')
                  ? '/api/auth/:operation'
                  : 'unmatched',
            status: response.statusCode,
            durationMs: Math.round(performance.now() - start),
          }) + '\n',
        );
      }
    });
    requestBudget.run({ deadline: Date.now() + timeout }, next);
  });
  app.use(businessConfirmationBodyParser);
  app.enableCors({
    origin: config.trustedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Dayline-Expected-User',
      'If-None-Match',
      'X-Dayline-Scanner-Proof',
      'X-Dayline-Method-Override',
      'X-Dayline-File-Format',
      'X-Dayline-Operation-ID',
    ],
    exposedHeaders: [
      'set-auth-token',
      'X-Request-ID',
      'ETag',
      'Retry-After',
      'Content-Disposition',
    ],
  });
  if (config.webDistDirectory)
    app.use(createStaticSite(config.webDistDirectory));
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResultInterceptor());
  app.enableShutdownHooks();
  if (config.environment !== 'production') {
    const options = new DocumentBuilder()
      .setTitle('Dayline API')
      .setVersion('0.1')
      .addCookieAuth('better-auth.session_token')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, options),
    );
  }
  return app;
}

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/environment.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { ApiResultInterceptor } from './common/api-result.interceptor.js';

export async function createApp(config: AppConfig) {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config),
    {
      bodyParser: false,
      logger: config.environment === 'test' ? false : ['log', 'warn', 'error'],
    },
  );
  app.use(helmet());
  app.use((request: Request, response: Response, next: NextFunction) => {
    request.requestId = randomUUID();
    response.setHeader('X-Request-ID', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: config.trustedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Dayline-Expected-User',
      'If-None-Match',
    ],
    exposedHeaders: ['set-auth-token', 'X-Request-ID', 'ETag'],
  });
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

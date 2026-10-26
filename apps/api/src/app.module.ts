import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config/environment.js';
import { RuntimeConfigModule } from './config/runtime-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IdentityModule } from './auth/identity.module.js';
import { SessionGuard } from './auth/session.guard.js';
import { HealthController } from './health/health.controller.js';
import { UsersModule } from './users/users.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        RuntimeConfigModule.register(config),
        DatabaseModule,
        IdentityModule,
        UsersModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
    };
  }
}

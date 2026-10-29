import { SecurityModule } from './security/security.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { ClockModule } from './common/clock.module.js';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config/environment.js';
import { RuntimeConfigModule } from './config/runtime-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IdentityModule } from './auth/identity.module.js';
import { SessionGuard } from './auth/session.guard.js';
import { HealthController } from './health/health.controller.js';
import type { WechatAdapter } from './wechat/wechat-adapter.js';
import { WechatModule } from './wechat/wechat.module.js';
import { RecordsModule } from './records/records.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { UsersModule } from './users/users.module.js';
import { LanguageModule } from './i18n/language.module.js';

@Module({})
export class AppModule {
  static register(
    config: AppConfig,
    testWechatAdapter?: WechatAdapter,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LanguageModule,
        RuntimeConfigModule.register(config),
        ClockModule,
        SecurityModule,
        DatabaseModule,
        MaintenanceModule,
        IdentityModule,
        UsersModule,
        RecordsModule,
        ImportsModule,
        WechatModule.register(testWechatAdapter),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
    };
  }
}

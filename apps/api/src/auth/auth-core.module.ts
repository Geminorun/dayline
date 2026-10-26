import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { MailModule } from '../mail/mail.module.js';
import { MailService } from '../mail/mail.service.js';
import { AuthAccessService } from './auth-access.service.js';
import { AUTH_INSTANCE, createAuth } from './create-auth.js';

@Global()
@Module({
  imports: [DatabaseModule, MailModule],
  providers: [
    {
      provide: AUTH_INSTANCE,
      inject: [APP_CONFIG, PrismaService, MailService],
      useFactory: (
        config: AppConfig,
        database: PrismaService,
        mail: MailService,
      ) => createAuth(config, database, mail),
    },
    AuthAccessService,
  ],
  exports: [AUTH_INSTANCE, AuthAccessService],
})
export class AuthCoreModule {}

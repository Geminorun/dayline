import { SecurityService } from '../security/security.service.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { AuthAccessService } from './auth-access.service.js';
import { AuthCoreModule } from './auth-core.module.js';
import { AUTH_INSTANCE } from './create-auth.js';
import type { DaylineAuth } from './create-auth.js';
import { nativeAuthPolicy } from './native-auth-policy.js';
import { AuthController } from './auth.controller.js';

@Module({
  imports: [
    AuthCoreModule,
    AuthModule.forRootAsync({
      imports: [AuthCoreModule],
      inject: [AUTH_INSTANCE, AuthAccessService, SecurityService],
      disableGlobalAuthGuard: true,
      useFactory: (
        auth: DaylineAuth,
        access: AuthAccessService,
        security: SecurityService,
      ) => ({
        auth,
        disableTrustedOriginsCors: true,
        bodyParser: { json: { limit: '64kb' }, urlencoded: { enabled: false } },
        middleware: nativeAuthPolicy(access, security),
      }),
    }),
  ],
  controllers: [AuthController],
})
export class IdentityModule {}

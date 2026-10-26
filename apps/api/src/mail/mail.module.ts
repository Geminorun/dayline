import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { FileMailTransport } from './file-mail.transport.js';
import { MAIL_TRANSPORT } from './mail-transport.js';
import { MailService } from './mail.service.js';
import { ResendMailTransport } from './resend-mail.transport.js';

@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.mailTransport === 'file')
          return new FileMailTransport(config.mailPreviewDirectory);
        if (!config.resendApiKey)
          throw new Error('Resend configuration is missing.');
        return new ResendMailTransport(
          config.resendApiKey,
          config.mailFrom,
          config.externalTimeoutMs,
        );
      },
    },
    MailService,
  ],
  exports: [MailService, MAIL_TRANSPORT],
})
export class MailModule {}

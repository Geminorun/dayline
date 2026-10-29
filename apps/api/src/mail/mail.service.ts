import type { Locale } from '@dayline/locales';
import { serverText } from '../i18n/server-text.js';
import { msg } from '@dayline/locales';
import { AppError } from '../common/app-error.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';
import { errorDiagnostics } from '../common/error-diagnostics.js';
import { MailDeliveryError } from './mail-delivery.error.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async sendVerification(
    to: string,
    url: string,
    locale?: Locale,
  ): Promise<void> {
    await this.sendLink(to, url, 'email_verification', 'verification', locale);
  }
  async sendEmailBinding(
    to: string,
    url: string,
    locale?: Locale,
  ): Promise<void> {
    await this.sendLink(to, url, 'email_binding', 'binding', locale);
  }
  async sendPasswordReset(
    to: string,
    url: string,
    locale?: Locale,
  ): Promise<void> {
    await this.sendLink(to, url, 'password_reset', 'reset', locale);
  }
  private async sendLink(
    to: string,
    url: string,
    purpose: 'email_verification' | 'email_binding' | 'password_reset',
    template: 'verification' | 'binding' | 'reset',
    locale?: Locale,
  ) {
    if (to.toLowerCase().endsWith('.invalid'))
      throw new Error(
        'Internal identity addresses cannot receive transactional mail.',
      );
    const subject = serverText(msg(`emails.${template}.subject`), locale);
    const action = serverText(msg(`emails.${template}.action`), locale);
    const description = serverText(
      msg(`emails.${template}.description`),
      locale,
    );
    const footer = serverText(msg('emails.footer'), locale);
    try {
      const receipt = await this.transport.send({
        to,
        subject,
        text: `${description}\n\n${action}: ${url}\n\n${footer}`,
        html: `<p>${escapeHtml(description)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p>${escapeHtml(footer)}</p>`,
      });
      this.logger.log({
        code: 'MAIL_ACCEPTED',
        purpose,
        ...(receipt ? { messageId: receipt.messageId } : {}),
      });
    } catch (cause) {
      this.logger.error({
        code: 'MAIL_DELIVERY_FAILED',
        purpose,
        ...(cause instanceof MailDeliveryError
          ? {
              provider: 'resend',
              providerCode: cause.providerCode,
              providerStatus: cause.providerStatus,
            }
          : {}),
        ...errorDiagnostics(cause),
      });
      throw new AppError(
        503,
        'MAIL_UNAVAILABLE',
        msg('errors.theEmailCannotBeSentTemporarilyPlease'),
        undefined,
        cause,
      );
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

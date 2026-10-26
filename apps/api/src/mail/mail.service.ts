import { Inject, Injectable } from '@nestjs/common';
import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';

@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async sendVerification(to: string, url: string): Promise<void> {
    await this.sendLink(
      to,
      url,
      '验证日序邮箱',
      '验证邮箱',
      '此链接用于确认你的邮箱地址。',
    );
  }

  async sendPasswordReset(to: string, url: string): Promise<void> {
    await this.sendLink(
      to,
      url,
      '重置日序密码',
      '重置密码',
      '如果你没有申请重置密码，可忽略此邮件。',
    );
  }

  private async sendLink(
    to: string,
    url: string,
    subject: string,
    action: string,
    description: string,
  ) {
    if (to.toLowerCase().endsWith('.invalid')) {
      throw new Error(
        'Internal identity addresses cannot receive transactional mail.',
      );
    }
    await this.transport.send({
      to,
      subject,
      text: `${description}\n\n${action}：${url}\n\n链接有时效，请勿转发。`,
      html: `<p>${description}</p><p><a href="${escapeHtml(url)}">${action}</a></p><p>链接有时效，请勿转发。</p>`,
    });
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

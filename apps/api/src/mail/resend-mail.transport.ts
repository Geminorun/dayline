import { Resend } from 'resend';
import type { MailTransport, TransactionalMail } from './mail-transport.js';

export class ResendMailTransport implements MailTransport {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(mail: TransactionalMail): Promise<void> {
    try {
      const { error } = await this.client.emails.send(
        { from: this.from, ...mail },
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!error) return;
    } catch {
      // Provider errors must not expose keys, recipient details, or request bodies.
    }
    throw new Error(
      'Transactional mail was not accepted by the mail provider.',
    );
  }
}

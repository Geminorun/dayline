import { Resend } from 'resend';
import type { MailTransport, TransactionalMail } from './mail-transport.js';
import { MailDeliveryError } from './mail-delivery.error.js';

export class ResendMailTransport implements MailTransport {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly timeoutMs = 8000,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(mail: TransactionalMail): Promise<{ messageId: string }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const { data, error } = await this.client.emails.send(
        { from: this.from, ...mail },
        { signal },
      );
      if (!error) {
        if (!data || !/^[\w-]{1,100}$/.test(data.id))
          throw new MailDeliveryError('invalid_response');
        return { messageId: data.id };
      }
      const names = new Set([
        'validation_error',
        'missing_api_key',
        'invalid_api_key',
        'restricted_api_key',
        'rate_limit_exceeded',
        'daily_quota_exceeded',
        'monthly_quota_exceeded',
        'application_error',
        'internal_server_error',
        'invalid_access',
        'not_found',
      ]);
      throw new MailDeliveryError(
        signal.aborted
          ? 'timeout'
          : error.name === 'application_error' && error.statusCode == null
            ? 'network_error'
            : names.has(error.name)
              ? error.name
              : 'provider_rejected',
        typeof error.statusCode === 'number' ? error.statusCode : undefined,
      );
    } catch (cause) {
      if (cause instanceof MailDeliveryError) throw cause;
      throw new MailDeliveryError(
        cause instanceof Error &&
          ['TimeoutError', 'AbortError'].includes(cause.name)
          ? 'timeout'
          : 'network_error',
        undefined,
        cause,
      );
    }
  }
}

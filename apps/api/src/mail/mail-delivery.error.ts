export class MailDeliveryError extends Error {
  constructor(
    readonly providerCode: string,
    readonly providerStatus?: number,
    cause?: unknown,
  ) {
    super('Transactional mail was not accepted by the mail provider.', {
      cause,
    });
    this.name = 'MailDeliveryError';
  }
}

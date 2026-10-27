export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface TransactionalMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  send(mail: TransactionalMail): Promise<void | { messageId: string }>;
}

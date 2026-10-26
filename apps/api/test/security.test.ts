import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { SecurityService } from '../src/security/security.service.js';
import { parseEnvironment } from '../src/config/environment.js';
import { MailService } from '../src/mail/mail.service.js';
const config = parseEnvironment({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost/dayline_test',
  AUTH_BASE_URL: 'http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:5173',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters',
  MAIL_TRANSPORT: 'file',
  MAIL_FROM: 'Dayline <noreply@example.com>',
});
afterEach(() => vi.restoreAllMocks());
it('recovers an exhausted bounded failure store after its windows expire', () => {
  const service = new SecurityService(config),
    now = vi.spyOn(Date, 'now').mockReturnValue(1000000);
  for (let i = 0; i < 10000; i++) service.failure('test', String(i), String(i));
  expect(() => service.checkFailures('test', 'new', 'new')).toThrow();
  now.mockReturnValue(1600001);
  expect(() => service.checkFailures('test', 'new', 'new')).not.toThrow();
});
it('records a fixed mail failure event without recipient, link or provider error and keeps the outward error safe', async () => {
  const logged = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => {});
  const mail = new MailService({
    send: async () => {
      throw new Error(
        'provider-private SQL secret@example.com https://secret/token',
      );
    },
  });
  await expect(
    mail.sendPasswordReset(
      'person@example.com',
      'https://example.com/reset?token=private',
    ),
  ).rejects.toMatchObject({ code: 'MAIL_UNAVAILABLE' });
  expect(logged).toHaveBeenCalledWith({
    code: 'MAIL_DELIVERY_FAILED',
    purpose: 'password_reset',
  });
  expect(JSON.stringify(logged.mock.calls)).not.toContain('person@example.com');
  expect(JSON.stringify(logged.mock.calls)).not.toContain('private');
});

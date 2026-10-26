import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config/environment.js';

const environment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/dayline_test',
  AUTH_BASE_URL: 'http://localhost:3000',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:5173,http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:5173',
  ACTION_PROOF_SECRET: 'test-only-action-proof-secret-independent-32-chars',
  BETTER_AUTH_SECRET:
    'test-only-authentication-secret-with-more-than-32-characters',
  MAIL_TRANSPORT: 'file',
  MAIL_FROM: 'Dayline <noreply@example.com>',
};

describe('configuration boundaries', () => {
  it('rejects file preview mail in production', () => {
    expect(() =>
      parseEnvironment({ ...environment, NODE_ENV: 'production' }),
    ).toThrow('Production requires the Resend');
  });

  it('requires a real provider key when Resend is selected', () => {
    expect(() =>
      parseEnvironment({ ...environment, MAIL_TRANSPORT: 'resend' }),
    ).toThrow('RESEND_API_KEY');
  });

  it('requires HTTPS and a replacement secret in production', () => {
    const production = {
      ...environment,
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'test-key',
    };
    expect(() => parseEnvironment(production)).toThrow('HTTPS');
    expect(() =>
      parseEnvironment({
        ...production,
        AUTH_BASE_URL: 'https://api.example.com',
        WEB_BASE_URL: 'https://example.com',
        ACTION_PROOF_SECRET:
          'test-only-action-proof-secret-independent-32-chars',
        BETTER_AUTH_SECRET: 'local-development-only-replace-before-production',
      }),
    ).toThrow('Replace the development');
  });

  it('rejects wildcard or path-based trusted origins', () => {
    expect(() =>
      parseEnvironment({ ...environment, AUTH_TRUSTED_ORIGINS: '*' }),
    ).toThrow('exact HTTP(S) origins');
    expect(() =>
      parseEnvironment({
        ...environment,
        AUTH_TRUSTED_ORIGINS: 'https://example.com/path',
      }),
    ).toThrow('exact HTTP(S) origins');
  });

  it('reports field names without printing secret values', () => {
    expect(() =>
      parseEnvironment({ ...environment, BETTER_AUTH_SECRET: 'private-value' }),
    ).toThrow('BETTER_AUTH_SECRET');
    try {
      parseEnvironment({ ...environment, BETTER_AUTH_SECRET: 'private-value' });
    } catch (error) {
      expect(error instanceof Error && error.message).not.toContain(
        'private-value',
      );
    }
  });

  it('rejects malformed URLs without leaking their values or throwing URL parser errors', () => {
    expect(() =>
      parseEnvironment({
        ...environment,
        DATABASE_URL: 'invalid-private-value',
      }),
    ).toThrow('Invalid configuration: DATABASE_URL');
    expect(() =>
      parseEnvironment({
        ...environment,
        DATABASE_URL: 'https://example.com/database',
      }),
    ).toThrow('DATABASE_URL');
    expect(() =>
      parseEnvironment({ ...environment, AUTH_BASE_URL: '*' }),
    ).toThrow('Invalid configuration: AUTH_BASE_URL');
  });
});

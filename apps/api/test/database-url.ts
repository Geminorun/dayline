import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export function testDatabaseUrl(): string {
  config({
    path: fileURLToPath(new URL('../../../.env', import.meta.url)),
    quiet: true,
  });
  const value = process.env.TEST_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(
      'Set TEST_DATABASE_URL to a dedicated PostgreSQL database ending in _test.',
    );
  }
  if (
    !value ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.pathname.endsWith('_test')
  ) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated PostgreSQL database ending in _test.',
    );
  }
  return value;
}

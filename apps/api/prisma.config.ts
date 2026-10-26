import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
  quiet: true,
});

export default defineConfig({
  schema: resolve(import.meta.dirname, 'prisma/schema.prisma'),
  migrations: { path: resolve(import.meta.dirname, 'prisma/migrations') },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://unused:unused@localhost:5432/unused',
  },
});

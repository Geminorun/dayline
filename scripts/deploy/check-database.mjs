import process from 'node:process';
import console from 'node:console';
import { createRequire } from 'node:module';
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 8000,
});
try {
  await client.connect();
  await client.query('SELECT 1');
} catch {
  console.error(
    'Application database connection failed; check the supplied password, role and Docker network. Existing credentials were not changed.',
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

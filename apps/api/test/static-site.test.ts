import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticSite } from '../src/web/static-site.js';

let directory: string;
const app = express();
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dayline-static-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html>Dayline</html>');
  await writeFile(
    join(directory, 'assets', 'app-hash.js'),
    'window.dayline=1;',
  );
  await writeFile(
    join(directory, 'sw.js'),
    'self.addEventListener("fetch",()=>{});',
  );
  await writeFile(
    join(directory, 'manifest.webmanifest'),
    JSON.stringify({ name: 'Dayline', start_url: '/day' }),
  );
  await writeFile(join(directory, '.env'), 'PRIVATE_VALUE=secret');
  app.use(createStaticSite(directory));
  app.use((_request, response) =>
    response.status(404).json({ error: 'missing' }),
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('single-container public website', () => {
  it('serves SPA deep links and verification links without caching HTML', async () => {
    for (const path of [
      '/day',
      '/entries/example',
      '/auth/verify?token=private',
    ]) {
      const response = await request(app).get(path).expect(200);
      expect(response.type).toBe('text/html');
      expect(response.text).toContain('Dayline');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    await request(app).head('/day').expect(200);
  });
  it('caches fingerprinted assets and does not turn missing assets into HTML', async () => {
    const response = await request(app).get('/assets/app-hash.js').expect(200);
    expect(response.headers['cache-control']).toContain('immutable');
    await request(app).get('/assets/missing.js').expect(404);
    await request(app).get('/favicon.ico').expect(404);
  });
  it('serves PWA metadata and worker with fresh headers and correct MIME types', async () => {
    const worker = await request(app).get('/sw.js').expect(200);
    expect(worker.type).toMatch(/javascript/);
    expect(worker.headers['cache-control']).toBe('no-store');
    const manifest = await request(app)
      .get('/manifest.webmanifest')
      .expect(200);
    expect(manifest.type).toBe('application/manifest+json');
    expect(manifest.headers['cache-control']).toBe('no-store');
    await request(app).get('/workbox-missing.js').expect(404);
    await request(app).get('/icons/missing.png').expect(404);
  });
  it('leaves API, auth, health, non-GET and hidden paths to their real handlers', async () => {
    for (const path of [
      '/api',
      '/api/auth/missing',
      '/api/v1/missing',
      '/health/ready',
      '/.env',
      '/.git/config',
    ]) {
      const response = await request(app).get(path).expect(404);
      expect(response.type).toBe('application/json');
      expect(response.text).not.toContain('PRIVATE_VALUE');
    }
    await request(app).post('/day').expect(404);
    await request(app)
      .get('/day')
      .set('Accept', 'application/json')
      .expect(404);
  });
});

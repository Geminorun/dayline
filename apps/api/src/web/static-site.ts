import { statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import express from 'express';
import type { RequestHandler } from 'express';

// Public build output only. API, health, dotfiles and missing assets never receive SPA HTML.
export function createStaticSite(directory: string): RequestHandler {
  const root = resolve(directory);
  if (!statSync(resolve(root, 'index.html')).isFile())
    throw new Error('WEB_DIST_DIR must contain a built index.html.');
  const router = express.Router();
  router.use(
    express.static(root, {
      dotfiles: 'ignore',
      index: false,
      setHeaders(response, path) {
        response.setHeader(
          'Cache-Control',
          path.startsWith(resolve(root, 'assets') + '/')
            ? 'public, max-age=31536000, immutable'
            : 'no-store',
        );
      },
    }),
  );
  router.use((request, response, next) => {
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      request.path.startsWith('/assets/') ||
      extname(request.path) ||
      request.path.split('/').some((part) => part.startsWith('.')) ||
      !request.accepts('html')
    )
      return next();
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(resolve(root, 'index.html'));
  });
  return (request, response, next) => {
    if (/^\/(?:api|health)(?:\/|$)/.test(request.path)) return next();
    router(request, response, next);
  };
}

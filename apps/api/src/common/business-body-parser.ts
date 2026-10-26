import {
  MAX_FOCUS_REMOVAL_ACKNOWLEDGEMENTS,
  MAX_TRASH_PURGE_ENTRIES,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_FOCUS,
} from '@dayline/contracts';
import { json, raw } from 'express';
import type { RequestHandler } from 'express';
import { AppError } from './app-error.js';

const ordinaryLimit = 64 * 1024;
/** Only established bulk routes may exceed the ordinary JSON limit. Better Auth
 * retains its raw-body handler and all other routes keep 64 KiB. */
export const businessConfirmationBodyParser: RequestHandler = (
  request,
  response,
  next,
) => {
  if (
    request.method === 'POST' &&
    /^\/api\/v1\/imports\/preview\/?$/.test(request.path)
  ) {
    raw({ type: () => true, limit: 10 * 1024 * 1024, inflate: false })(
      request,
      response,
      next,
    );
    return;
  }
  if (
    request.method === 'POST' &&
    /^\/api\/v1\/guest-admissions\/prepare\/?$/.test(request.path)
  ) {
    json({ limit: 10 * 1024 * 1024, strict: true })(
      request,
      response,
      (error?: unknown) => {
        if (error) {
          next(error);
          return;
        }
        const body: unknown = request.body;
        const source: unknown =
          typeof body === 'object' && body !== null
            ? Reflect.get(body, 'package')
            : undefined;
        if (typeof source === 'object' && source !== null) {
          const entries: unknown = Reflect.get(source, 'entries'),
            focus: unknown = Reflect.get(source, 'focusDays');
          if (
            (Array.isArray(entries) && entries.length > MAX_IMPORT_ENTRIES) ||
            (Array.isArray(focus) && focus.length > MAX_IMPORT_FOCUS)
          ) {
            next(
              new AppError(
                422,
                'IMPORT_INVALID',
                '接入包超过事项或重点数量限制。',
              ),
            );
            return;
          }
        }
        next();
      },
    );
    return;
  }
  if (
    request.method === 'POST' &&
    /^\/api\/v1\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/review\/?$/i.test(
      request.path,
    )
  ) {
    json({ limit: 4 * 1024 * 1024, strict: true })(
      request,
      response,
      (error?: unknown) => {
        if (error) {
          next(error);
          return;
        }
        const body: unknown = request.body;
        if (typeof body === 'object' && body !== null) {
          const rows: unknown = Reflect.get(body, 'rows'),
            categories: unknown = Reflect.get(body, 'categories');
          if (
            (Array.isArray(rows) && rows.length > MAX_IMPORT_ENTRIES) ||
            (Array.isArray(categories) && categories.length > 20)
          ) {
            next(new AppError(422, 'IMPORT_INVALID', '预览选择超过条数限制。'));
            return;
          }
        }
        next();
      },
    );
    return;
  }
  const focusRoute =
    request.method === 'PATCH' &&
    /^\/api\/v1\/entries\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(
      request.path,
    );
  const purgeRoute =
    request.method === 'POST' &&
    /^\/api\/v1\/trash\/purge\/?$/.test(request.path);
  if (!focusRoute && !purgeRoute) {
    next();
    return;
  }
  const arrayKey = focusRoute ? 'focusRemovalAcknowledgement' : 'entries';
  const maxItems = focusRoute
    ? MAX_FOCUS_REMOVAL_ACKNOWLEDGEMENTS
    : MAX_TRASH_PURGE_ENTRIES;
  let bodyBytes = 0;
  json({
    limit: focusRoute ? 1024 * 1024 : 128 * 1024,
    strict: true,
    verify: (_request, _response, body) => {
      bodyBytes = body.length;
    },
  })(request, response, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    const body: unknown = request.body;
    const collection: unknown =
      typeof body === 'object' && body !== null && arrayKey in body
        ? Reflect.get(body, arrayKey)
        : undefined;
    if (Array.isArray(collection) && collection.length > maxItems) {
      next(
        new AppError(
          422,
          'VALIDATION_ERROR',
          `批量确认最多包含 ${maxItems} 项。`,
        ),
      );
      return;
    }
    if (bodyBytes > ordinaryLimit && !Array.isArray(collection)) {
      next(
        new AppError(413, 'INVALID_REQUEST', '普通事项请求不能超过 64 KiB。'),
      );
      return;
    }
    next();
  });
};

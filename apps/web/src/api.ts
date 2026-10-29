import { msg } from '@dayline/locales';
import { ClientError, ApiClient } from '@dayline/api-client';
import type { Transport } from '@dayline/api-client';
import { locale } from './i18n';

async function downloadText(response: Response) {
  const bytes = await response.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ClientError(
      'INVALID_RESPONSE',
      msg('api.theDownloadFileEncodingIsInvalidPlease'),
    );
  }
}
export const cookieTransport: Transport = async (request) => {
  const controller = new AbortController();
  const timeout =
    /^\/api\/v1\/(?:imports|guest-admissions|account-merges)(?:\/|$)/.test(
      request.path,
    )
      ? 65000
      : 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(request.path, {
      signal: controller.signal,
      method: request.method,
      credentials: 'include',
      headers: {
        'Accept-Language': locale.value,
        ...request.headers,
        ...(request.body === undefined
          ? {}
          : {
              'Content-Type': request.headers['X-Dayline-File-Format']
                ? 'application/octet-stream'
                : 'application/json',
            }),
      },
      ...(request.body === undefined
        ? {}
        : {
            body:
              request.headers['X-Dayline-File-Format'] &&
              typeof request.body === 'string'
                ? request.body
                : JSON.stringify(request.body),
          }),
    });
    const download = request.path.startsWith('/api/v1/exports/');
    if (
      download &&
      response.ok &&
      (!response.headers
        .get('content-disposition')
        ?.startsWith('attachment;') ||
        !response.headers
          .get('content-type')
          ?.startsWith(
            request.path.endsWith('json') ? 'application/json' : 'text/csv',
          ))
    )
      throw new ClientError(
        'INVALID_RESPONSE',
        msg('api.theDownloadResponseFormatIsInvalidPlease'),
      );
    const body: unknown =
      response.status === 204 || response.status === 304
        ? undefined
        : download && response.ok
          ? await downloadText(response)
          : await response.json();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      ...(body === undefined ? {} : { body }),
    };
  } finally {
    clearTimeout(timer);
  }
};
// HttpOnly Cookie is the sole browser credential; bearer tokens are never stored.
export const api = new ApiClient(cookieTransport);

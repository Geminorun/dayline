import { ClientError, ApiClient } from '@dayline/api-client';
import type { Transport } from '@dayline/api-client';

async function downloadText(response: Response) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await response.arrayBuffer(),
    );
  } catch {
    throw new ClientError('INVALID_RESPONSE', '下载文件编码无效，请重试。');
  }
}
export const cookieTransport: Transport = async (request) => {
  const response = await fetch(request.path, {
    method: request.method,
    credentials: 'include',
    headers: {
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
    (!response.headers.get('content-disposition')?.startsWith('attachment;') ||
      !response.headers
        .get('content-type')
        ?.startsWith(
          request.path.endsWith('json') ? 'application/json' : 'text/csv',
        ))
  )
    throw new ClientError('INVALID_RESPONSE', '下载响应格式无效，请重试。');
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
};
// HttpOnly Cookie is the sole browser credential; bearer tokens are never stored.
export const api = new ApiClient(cookieTransport);

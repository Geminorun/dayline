import { ApiClient } from '@dayline/api-client';
import type { Transport } from '@dayline/api-client';

export const cookieTransport: Transport = async (request) => {
  const response = await fetch(request.path, {
    method: request.method,
    credentials: 'include',
    headers: {
      ...request.headers,
      ...(request.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
  });
  const body: unknown =
    response.status === 204 || response.status === 304
      ? undefined
      : await response.json();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    ...(body === undefined ? {} : { body }),
  };
};
// HttpOnly Cookie is the sole browser credential; bearer tokens are never stored.
export const api = new ApiClient(cookieTransport);

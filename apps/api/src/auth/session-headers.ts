import type { Response } from 'express';

export function forwardSessionHeaders(
  response: Response,
  headers: Headers,
): void {
  for (const cookie of headers.getSetCookie())
    response.append('set-cookie', cookie);
  const token = headers.get('set-auth-token');
  if (token) response.setHeader('set-auth-token', token);
}

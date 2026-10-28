import { emailFlowSchema } from '@dayline/contracts';
import type { EmailFlow } from '@dayline/contracts';

const key = 'dayline:auth-email';
export interface AuthEmailState {
  email: string;
  flow?: EmailFlow;
  retryUntil: number;
  limited: boolean;
  retryScope?: 'mail' | 'login';
}
export function readAuthEmail(): AuthEmailState {
  const empty = { email: '', retryUntil: 0, limited: false };
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      !value ||
      typeof value !== 'object' ||
      !('email' in value) ||
      typeof value.email !== 'string' ||
      value.email.length > 320
    )
      return empty;
    const until =
      'retryUntil' in value &&
      typeof value.retryUntil === 'number' &&
      Number.isFinite(value.retryUntil) &&
      value.retryUntil <= Date.now() + 86400000
        ? value.retryUntil
        : 0;
    const flow = emailFlowSchema.safeParse(
      'flow' in value ? value.flow : undefined,
    );
    return {
      email: value.email,
      retryUntil: until,
      limited: 'limited' in value && value.limited === true,
      retryScope:
        'retryScope' in value && value.retryScope === 'login'
          ? 'login'
          : 'mail',
      ...(flow.success ? { flow: flow.data } : {}),
    };
  } catch {
    return empty;
  }
}
/** Only email, delivery guidance and cooldown survive navigation; never credentials. */
export function writeAuthEmail(state: AuthEmailState) {
  try {
    sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* Optional form convenience. */
  }
}

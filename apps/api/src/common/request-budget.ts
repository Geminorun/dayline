import type { Locale } from '@dayline/locales';
import { msg } from '@dayline/locales';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './app-error.js';
import type { EmailFlow } from '@dayline/contracts';
export const requestBudget = new AsyncLocalStorage<{
  locale?: Locale;
  deadline: number;
  requestId?: string;
  verificationUserId?: string;
  authEmail?: string;
  authPath?: string;
  emailFlow?: EmailFlow;
  mailRetrySeconds?: number;
  mailRetryUntil?: number;
}>();
export function remainingBudget(fallback: number): number {
  const remaining = requestBudget.getStore()?.deadline;
  const value =
    remaining === undefined
      ? fallback
      : Math.min(fallback, remaining - Date.now());
  if (value <= 0)
    throw new AppError(
      504,
      'REQUEST_TIMEOUT',
      msg('errors.theOperationResultHasNotBeenConfirmed'),
    );
  return value;
}

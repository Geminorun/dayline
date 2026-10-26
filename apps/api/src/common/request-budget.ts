import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './app-error.js';
export const requestBudget = new AsyncLocalStorage<{
  deadline: number;
  verificationUserId?: string;
  authEmail?: string;
  authPath?: string;
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
      '操作结果尚未确认，请读取当前记录或原任务状态后再决定。',
    );
  return value;
}

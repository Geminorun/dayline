import { z } from 'zod';

export const EXPECTED_USER_HEADER = 'x-dayline-expected-user';
export const USER_STATUSES = ['active', 'pending_deletion', 'merged'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const displayNameSchema = z
  .string()
  .trim()
  .refine(
    (value) => [...value].length >= 1 && [...value].length <= 40,
    '显示名须为 1–40 个字符。',
  );

export interface UserDto {
  id: string;
  displayName: string;
  profileVersion: number;
  email: string | null;
  emailVerified: boolean;
  passwordEnabled: boolean;
  wechatBound: boolean;
  status: UserStatus;
  deletionDueAt: string | null;
  timeZone: 'Asia/Shanghai';
}

export interface ApiMeta {
  requestId: string;
  serverTime: string;
  dataVersion?: string;
}

export interface ApiResult<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorResult {
  error: { code: string; message: string; details?: unknown };
  meta: ApiMeta;
}

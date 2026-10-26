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

export const wechatLoginSchema = z
  .object({ code: z.string().min(1).max(512) })
  .strict();
export const qrCreateSchema = z
  .object({ id: z.uuid(), purpose: z.enum(['login', 'bind_wechat']) })
  .strict();
export const qrResolveSchema = z
  .object({
    scene: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    code: z.string().min(1).max(512),
  })
  .strict();
export const qrConfirmSchema = z
  .object({ scannerProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const QR_STATUSES = [
  'pending',
  'scanned',
  'confirmed',
  'consumed',
  'cancelled',
  'expired',
] as const;
export type QrStatus = (typeof QR_STATUSES)[number];
export interface QrStatusDto {
  id: string;
  purpose: 'login';
  status: QrStatus;
  expiresAt: string;
}
export interface QrCreatedDto extends QrStatusDto {
  miniappCode: string;
}
export interface QrResolvedDto extends QrStatusDto {
  scannerProof: string;
}
export interface WechatLoginDto {
  user: UserDto;
  expiresAt: string;
}

export const realEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine(
    (email) => !email.endsWith('.invalid'),
    '请使用可接收邮件的真实邮箱。',
  );

export const userDtoSchema: z.ZodType<UserDto> = z
  .object({
    id: z.uuid(),
    displayName: displayNameSchema,
    profileVersion: z.number().int().positive(),
    email: realEmailSchema.nullable(),
    emailVerified: z.boolean(),
    passwordEnabled: z.boolean(),
    wechatBound: z.boolean(),
    status: z.enum(USER_STATUSES),
    deletionDueAt: z.iso.datetime().nullable(),
    timeZone: z.literal('Asia/Shanghai'),
  })
  .refine((user) => user.email !== null || !user.emailVerified);
export const qrStatusDtoSchema: z.ZodType<QrStatusDto> = z.object({
  id: z.uuid(),
  purpose: z.literal('login'),
  status: z.enum(QR_STATUSES),
  expiresAt: z.iso.datetime(),
});
export const qrCreatedDtoSchema: z.ZodType<QrCreatedDto> = z.object({
  id: z.uuid(),
  purpose: z.literal('login'),
  status: z.enum(QR_STATUSES),
  expiresAt: z.iso.datetime(),
  miniappCode: z
    .string()
    .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/),
});
export const qrResolvedDtoSchema: z.ZodType<QrResolvedDto> = z.object({
  id: z.uuid(),
  purpose: z.literal('login'),
  status: z.literal('scanned'),
  expiresAt: z.iso.datetime(),
  scannerProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const wechatLoginDtoSchema: z.ZodType<WechatLoginDto> = z.object({
  user: userDtoSchema,
  expiresAt: z.iso.datetime(),
});
export const successDtoSchema = z.object({ success: z.literal(true) });
export const nativeStatusSchema = z.object({ status: z.literal(true) });
export const nativeUserSchema = z.object({ user: z.object({ id: z.uuid() }) });
export * from './records.js';

export const apiMetaSchema = z
  .object({
    requestId: z.string().min(1),
    serverTime: z.iso.datetime(),
    dataVersion: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .transform((meta): ApiMeta => ({
    requestId: meta.requestId,
    serverTime: meta.serverTime,
    ...(meta.dataVersion === undefined
      ? {}
      : { dataVersion: meta.dataVersion }),
  }));
export * from './guest.js';
export const patchProfileSchema = z
  .object({
    displayName: displayNameSchema,
    expectedProfileVersion: z.number().int().min(1).max(2147483647),
  })
  .strict();
export type PatchProfileInput = z.infer<typeof patchProfileSchema>;

export * from './guest-manifest.js';

export * from './local.js';
export * from './imports.js';

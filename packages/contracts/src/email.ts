import { z } from 'zod';
export const realEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine(
    (email) => !email.endsWith('.invalid'),
    '请使用可接收邮件的真实邮箱。',
  );

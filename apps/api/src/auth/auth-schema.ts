import { betterAuth } from 'better-auth';
import { authModelOptions } from './auth-model-options.js';

// Schema generation only: no database, mail delivery, or runtime credentials.
export const auth = betterAuth({
  ...authModelOptions,
  baseURL: 'http://localhost:3000',
  secret: 'schema-generation-only-not-a-runtime-secret',
  emailAndPassword: { enabled: true, requireEmailVerification: true },
});

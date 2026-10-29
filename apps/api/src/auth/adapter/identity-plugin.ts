import { msg } from '@dayline/locales';
import { serverText } from '../../i18n/server-text.js';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

/** No URL: this endpoint is callable only through the server-side AuthAdapter. */
export function identityPlugin() {
  return {
    id: 'dayline-identity',
    endpoints: {
      createDaylineSession: createAuthEndpoint(
        {
          method: 'POST',
          body: z.object({ userId: z.uuid() }).strict(),
        },
        async (context) => {
          const user = await context.context.internalAdapter.findUserById(
            context.body.userId,
          );
          if (
            !user ||
            !z
              .object({ status: z.enum(['active', 'pending_deletion']) })
              .safeParse(user).success
          )
            throw new APIError('FORBIDDEN', {
              message: serverText(
                msg('errors.theAccountIsTemporarilyUnavailableForLogin'),
              ),
            });
          const session = await context.context.internalAdapter.createSession(
            user.id,
            false,
            { authMethod: 'wechat' },
            true,
          );
          await setSessionCookie(context, { user, session });
          return context.json({ expiresAt: session.expiresAt.toISOString() });
        },
      ),
    },
  };
}

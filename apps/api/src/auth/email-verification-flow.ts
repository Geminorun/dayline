import { createHash } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { Logger } from '@nestjs/common';
import { errorDiagnostics } from '../common/error-diagnostics.js';
import type { AppConfig } from '../config/environment.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { MailService } from '../mail/mail.service.js';
import type { Clock } from '../records/clock.js';
import { requestBudget } from '../common/request-budget.js';
import { MailDeliveryError } from '../mail/mail-delivery.error.js';
import { normalizeLocale } from '@dayline/locales';
import { requestLocale } from '../i18n/server-text.js';

type VerificationUser = { id: string; email: string; emailVerified: boolean };

/** Extends the library's signup/resend hooks without changing credentials or issuing sessions. */
export class EmailVerificationFlow {
  private readonly logger = new Logger(EmailVerificationFlow.name);
  constructor(
    private readonly config: AppConfig,
    private readonly database: PrismaService,
    private readonly mail: MailService,
    private readonly clock: Clock,
  ) {}

  async prepare(email: string) {
    const scope = requestBudget.getStore();
    if (!scope) return;
    const user = await this.database.user.findUnique({ where: { email } });
    const registered = !!user?.emailVerified;
    scope.emailFlow = {
      nextStep: registered ? 'login' : 'verify_email',
      accountStatus: user
        ? registered
          ? 'registered'
          : 'pending_verification'
        : 'unknown',
      mailStatus: 'not_sent',
      retryAfterSeconds: scope.mailRetrySeconds ?? 0,
    };
  }

  async send(user: VerificationUser, url: string) {
    const scope = requestBudget.getStore();
    if (scope?.emailFlow) {
      if (
        scope.authPath === '/sign-up/email' &&
        scope.emailFlow.accountStatus === 'unknown'
      )
        scope.emailFlow.accountStatus = 'created';
      scope.emailFlow.mailStatus = 'failed';
    }
    try {
      const token = new URL(url).searchParams.get('token');
      if (!token) throw new Error('Missing email verification token.');
      await this.database.verification.create({
        data: {
          identifier:
            'dayline-email-verification:' +
            createHash('sha256').update(token).digest('hex'),
          value: user.id,
          expiresAt: new Date(this.clock.now().getTime() + 86400000),
        },
      });
      // New signup mail runs before Better Auth commits its user transaction.
      // An independent read may see no row; retain the request language then.
      const profile = await this.database.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      await this.mail.sendVerification(
        user.email,
        url,
        normalizeLocale(profile?.locale ?? requestLocale()),
      );
      if (scope?.emailFlow) scope.emailFlow.mailStatus = 'accepted';
    } catch (cause) {
      const delivery = cause instanceof Error ? cause.cause : undefined;
      if (
        scope?.emailFlow &&
        delivery instanceof MailDeliveryError &&
        ['timeout', 'network_error'].includes(delivery.providerCode)
      )
        scope.emailFlow.mailStatus = 'unconfirmed';
      if (scope?.emailFlow) {
        this.logger.error({
          code: 'EMAIL_FLOW_FAILED',
          ...errorDiagnostics(cause),
        });
        return;
      }
      throw cause;
    }
  }

  async resume(user: VerificationUser, request?: Request) {
    const current = await this.database.user.findUnique({
      where: { id: user.id },
    });
    const flow = requestBudget.getStore()?.emailFlow;
    if (flow && current) {
      flow.accountStatus = current.emailVerified
        ? 'registered'
        : 'pending_verification';
      flow.nextStep = current.emailVerified ? 'login' : 'verify_email';
    }
    if (
      !current ||
      current.status !== 'active' ||
      current.emailVerified ||
      current.emailKind !== 'real'
    )
      return;
    let callbackURL = new URL('/login', this.config.webBaseUrl).href;
    const body: unknown = request
      ? await request.json().catch(() => null)
      : null;
    if (
      body &&
      typeof body === 'object' &&
      'callbackURL' in body &&
      typeof body.callbackURL === 'string'
    ) {
      const candidate = new URL(body.callbackURL, this.config.webBaseUrl);
      if (this.config.trustedOrigins.includes(candidate.origin))
        callbackURL = candidate.href;
    }
    const token = await createEmailVerificationToken(
      this.config.authSecret,
      current.email,
      undefined,
      86400,
    );
    const url = new URL('/api/auth/verify-email', this.config.authBaseUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('callbackURL', callbackURL);
    await this.send(current, url.href);
  }
}

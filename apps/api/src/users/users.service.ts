import { msg, normalizeLocale } from '@dayline/locales';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_TIME_ZONE } from '@dayline/core';
import { USER_STATUSES } from '@dayline/contracts';
import type { UserDto, PatchProfileInput } from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Actor } from '../common/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';

const profileSelect = {
  id: true,
  name: true,
  locale: true,
  email: true,
  emailVerified: true,
  emailKind: true,
  profileVersion: true,
  status: true,
  deletionDueAt: true,
  wechatIdentities: { select: { id: true }, take: 1 },
  accounts: {
    where: { providerId: 'credential', password: { not: null } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly database: PrismaService,
  ) {}

  async update(actor: Actor, input: PatchProfileInput): Promise<UserDto> {
    return this.database.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: actor.userId } });
      if (
        !user ||
        user.status === 'merged' ||
        user.authEpoch !== actor.authEpoch
      )
        throw new AppError(
          401,
          'SESSION_REVOKED',
          msg('errors.theLoginStatusHasExpired'),
        );
      if (user.status !== 'active')
        throw new AppError(
          403,
          'ACCOUNT_PENDING_DELETION',
          msg('errors.accountDeletionIsPending'),
        );
      if (user.profileVersion !== input.expectedProfileVersion)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          msg('errors.profileConflict'),
          {
            expectedVersion: input.expectedProfileVersion,
            currentVersion: user.profileVersion,
          },
        );
      if (
        (input.displayName !== undefined && user.name !== input.displayName) ||
        (input.locale !== undefined && user.locale !== input.locale)
      )
        await tx.user.update({
          where: { id: actor.userId },
          data: {
            ...(input.displayName === undefined
              ? {}
              : { name: input.displayName }),
            ...(input.locale === undefined ? {} : { locale: input.locale }),
            profileVersion: { increment: 1 },
          },
        });
      return readProfile(tx, actor.userId);
    });
  }

  async read(userId: string): Promise<UserDto> {
    return readProfile(this.database, userId);
  }
}

async function readProfile(
  database: Pick<PrismaService, 'user'>,
  userId: string,
): Promise<UserDto> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: profileSelect,
  });
  if (!user)
    throw new AppError(
      404,
      'RESOURCE_NOT_FOUND',
      msg('errors.theAccountDoesNotExist'),
    );
  return {
    id: user.id,
    locale: normalizeLocale(user.locale),
    displayName: user.name,
    profileVersion: user.profileVersion,
    email: user.emailKind === 'real' ? user.email : null,
    emailVerified: user.emailKind === 'real' && user.emailVerified,
    passwordEnabled: user.accounts.length > 0,
    wechatBound: user.wechatIdentities.length > 0,
    status: z.enum(USER_STATUSES).parse(user.status),
    deletionDueAt: user.deletionDueAt?.toISOString() ?? null,
    timeZone: BUSINESS_TIME_ZONE,
  };
}

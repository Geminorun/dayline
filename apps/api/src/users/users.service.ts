import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_TIME_ZONE } from '@dayline/core';
import { USER_STATUSES } from '@dayline/contracts';
import type { UserDto } from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const profileSelect = {
  id: true,
  name: true,
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
  if (!user) throw new AppError(404, 'RESOURCE_NOT_FOUND', '账号不存在。');
  return {
    id: user.id,
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

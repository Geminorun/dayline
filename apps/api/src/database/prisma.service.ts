import { remainingBudget } from '../common/request-budget.js';
import type { Prisma } from '../generated/prisma/client.js';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: 10,
        connectionTimeoutMillis: config.requestTimeoutMs,
        idleTimeoutMillis: 30000,
        statement_timeout: config.requestTimeoutMs,
      }),
    });
  }

  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    } = {},
  ): Promise<T> {
    const timeout = remainingBudget(options.timeout ?? 15000);
    return this.$transaction(
      async (tx) => {
        // PG and Prisma both bound lock/statement time; never send an early timeout while a write continues.
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(timeout)}, true)`;
        const result = await work(tx);
        remainingBudget(timeout);
        return result;
      },
      {
        ...options,
        maxWait: Math.min(options.maxWait ?? 10000, timeout),
        timeout,
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

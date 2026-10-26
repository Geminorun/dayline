import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeletionResult } from '@dayline/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { Clock } from '../records/clock.js';
import { ActionProofService } from '../auth/action-proof.service.js';
import type { Actor } from '../common/request-context.js';
import { AppError } from '../common/app-error.js';
@Injectable()
export class DeletionService {
  private readonly logger = new Logger(DeletionService.name);
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(ActionProofService) private readonly proofs: ActionProofService,
  ) {}
  async change(
    actor: Actor,
    input: { operationId: string; proof: string },
    cancel: boolean,
  ): Promise<DeletionResult> {
    const action = {
      purpose: cancel
        ? ('cancel_deletion' as const)
        : ('delete_account' as const),
      operationId: input.operationId,
      target: actor.userId,
    };
    const result = await this.db.transaction<DeletionResult>(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
        const user = await this.proofs.current(tx, actor, true);
        await this.proofs.verify(input.proof, actor, action);
        const now = this.clock.now();
        if (cancel) {
          if (user.status === 'active')
            return {
              status: 'active',
              requestedAt: null,
              dueAt: null,
              reauthenticate: false,
            };
          if (!user.deletionDueAt || now >= user.deletionDueAt)
            throw new AppError(
              410,
              'DELETION_EXPIRED',
              '注销撤销期限已过，账号不能恢复。',
            );
          await tx.user.update({
            where: { id: user.id },
            data: {
              status: 'active',
              deletionRequestedAt: null,
              deletionDueAt: null,
              authEpoch: { increment: 1 },
            },
          });
        } else {
          if (user.status === 'pending_deletion')
            return {
              status: 'pending_deletion',
              requestedAt:
                user.deletionRequestedAt?.toISOString() ??
                new Date(
                  (user.deletionDueAt?.getTime() ?? 0) - 7 * 86400000,
                ).toISOString(),
              dueAt: user.deletionDueAt?.toISOString() ?? null,
              reauthenticate: false,
            };
          await tx.user.update({
            where: { id: user.id },
            data: {
              status: 'pending_deletion',
              deletionRequestedAt: now,
              deletionDueAt: new Date(now.getTime() + 7 * 86400000),
              authEpoch: { increment: 1 },
            },
          });
        }
        await tx.session.deleteMany({ where: { userId: user.id } });
        return {
          status: cancel ? 'active' : 'pending_deletion',
          requestedAt: cancel ? null : now.toISOString(),
          dueAt: cancel
            ? null
            : new Date(now.getTime() + 7 * 86400000).toISOString(),
          reauthenticate: true,
        };
      },
      { maxWait: 10000, timeout: 15000 },
    );
    this.logger.log({
      code:
        result.status === 'pending_deletion'
          ? 'ACCOUNT_DELETION_REQUESTED'
          : 'ACCOUNT_DELETION_CANCELLED',
      userId: actor.userId,
      operationId: input.operationId,
      dueAt: result.dueAt,
      requestedAt: result.requestedAt,
      recordedAt: this.clock.now().toISOString(),
    });
    return result;
  }
}

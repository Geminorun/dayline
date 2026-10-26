import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators.js';
import { AppError } from '../common/app-error.js';
import { PrismaService } from '../database/prisma.service.js';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MaintenanceService)
    private readonly maintenance: MaintenanceService,
    @Inject(PrismaService) private readonly database: PrismaService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: '进程存活检查' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: '数据库及基础模型可用性检查' })
  async ready() {
    this.maintenance.assertReady();
    try {
      await Promise.all([
        this.database.user.findFirst({
          select: {
            id: true,
            emailKind: true,
            authEpoch: true,
            status: true,
            deletionRequestedAt: true,
          },
        }),
        this.database.session.findFirst({
          select: { id: true, authEpoch: true, authMethod: true },
        }),
        this.database.account.findFirst({
          select: { id: true, providerId: true },
        }),
        this.database.verification.findFirst({
          select: { id: true, expiresAt: true },
        }),
      ]);
      return { status: 'ok' };
    } catch {
      throw new AppError(
        503,
        'DATABASE_UNAVAILABLE',
        '数据库或基础迁移尚未就绪。',
      );
    }
  }
}

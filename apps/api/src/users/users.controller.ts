import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPendingDeletion } from '../auth/auth.decorators.js';
import { AppError } from '../common/app-error.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('me')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @AllowPendingDeletion()
  @ApiOperation({ summary: '读取当前会话的公开账号信息' })
  me(@Req() request: Request) {
    if (!request.actor)
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    return this.users.read(request.actor.userId);
  }
}

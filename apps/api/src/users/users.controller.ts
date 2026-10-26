import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { userDtoSchema, patchProfileSchema } from '@dayline/contracts';
import { dataResponseSchema, dtoSchema } from '../common/openapi.js';
import { AllowPendingDeletion } from '../auth/auth.decorators.js';
import { AppError } from '../common/app-error.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('me')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Patch()
  @ApiOperation({ summary: '按资料版本修改显示名' })
  @ApiBody({ schema: dtoSchema(patchProfileSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(userDtoSchema) })
  update(@Req() request: Request, @Body() body: unknown) {
    if (!request.actor)
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    const input = patchProfileSchema.safeParse(body);
    if (!input.success)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        '显示名须为 1–40 个字符，并携带原资料版本。',
      );
    return this.users.update(request.actor, input.data);
  }

  @Get()
  @AllowPendingDeletion()
  @ApiOperation({ summary: '读取当前会话的公开账号信息' })
  @ApiResponse({ status: 200, schema: dataResponseSchema(userDtoSchema) })
  me(@Req() request: Request) {
    if (!request.actor)
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    return this.users.read(request.actor.userId);
  }
}

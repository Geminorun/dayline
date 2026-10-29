import { msg } from '@dayline/locales';
import { DeletionService } from './deletion.service.js';
import {
  deletionInputSchema,
  deletionResultSchema,
  userDtoSchema,
  patchProfileSchema,
} from '@dayline/contracts';
import {
  Body,
  Post,
  Delete,
  HttpCode,
  Controller,
  Get,
  Inject,
  Patch,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { dataResponseSchema, dtoSchema } from '../common/openapi.js';
import { AllowPendingDeletion } from '../auth/auth.decorators.js';
import { AppError } from '../common/app-error.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('me')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(DeletionService) private readonly deletion: DeletionService,
  ) {}

  @Post('deletion')
  @HttpCode(200)
  @AllowPendingDeletion()
  @ApiBody({ schema: dtoSchema(deletionInputSchema) })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(deletionResultSchema),
  })
  requestDeletion(@Req() request: Request, @Body() body: unknown) {
    return this.changeDeletion(request, body, false);
  }

  @Delete('deletion')
  @HttpCode(200)
  @AllowPendingDeletion()
  @ApiBody({ schema: dtoSchema(deletionInputSchema) })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(deletionResultSchema),
  })
  cancelDeletion(@Req() request: Request, @Body() body: unknown) {
    return this.changeDeletion(request, body, true);
  }

  private changeDeletion(request: Request, body: unknown, cancel: boolean) {
    if (!request.actor)
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        msg('errors.pleaseLogInFirst'),
      );
    const parsed = deletionInputSchema.safeParse(body);
    if (!parsed.success)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        msg('errors.pleaseReVerifyThisAccountDeletionOperation'),
      );
    return this.deletion.change(request.actor, parsed.data, cancel);
  }

  @Patch()
  @ApiOperation({ summary: '按资料版本修改显示名与语言偏好' })
  @ApiBody({ schema: dtoSchema(patchProfileSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(userDtoSchema) })
  update(@Req() request: Request, @Body() body: unknown) {
    if (!request.actor)
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        msg('errors.pleaseLogInFirst'),
      );
    const input = patchProfileSchema.safeParse(body);
    if (!input.success)
      throw new AppError(422, 'VALIDATION_ERROR', msg('errors.invalidProfile'));
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

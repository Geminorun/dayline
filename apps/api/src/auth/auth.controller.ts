import { Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { AllowPendingDeletion } from './auth.decorators.js';
import { AUTH_INSTANCE } from './create-auth.js';
import type { DaylineAuth } from './create-auth.js';
import { AppError } from '../common/app-error.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: DaylineAuth) {}

  @Post('logout')
  @HttpCode(200)
  @AllowPendingDeletion()
  @ApiOperation({ summary: '退出当前会话' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.api.signOut({
      headers: fromNodeHeaders(request.headers),
      asResponse: true,
    });
    if (!result.ok)
      throw new AppError(503, 'AUTH_UNAVAILABLE', '退出暂未完成，请重试。');
    for (const cookie of result.headers.getSetCookie())
      response.append('set-cookie', cookie);
    return { success: true };
  }
}

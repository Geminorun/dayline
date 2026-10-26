import { SecurityService } from '../security/security.service.js';
import { ApiTags, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { dtoSchema, dataResponseSchema } from '../common/openapi.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  actionProofDtoSchema,
  bindingResultSchema,
  successDtoSchema,
  mergePlanSchema,
  mergeMappingsSchema,
  mergeListSchema,
  emailBindingListSchema,
  realEmailSchema,
  emailBindingCreateSchema,
  emailBindingVerifySchema,
  emailBindingCompleteSchema,
  reauthSchema,
  mergePreviewInputSchema,
  mergeReviewSchema,
  mergeCommitSchema,
} from '@dayline/contracts';
import { Public, AllowPendingDeletion } from '../auth/auth.decorators.js';
import { AppError } from '../common/app-error.js';
import type { Actor } from '../common/request-context.js';
import { PrismaService } from '../database/prisma.service.js';
import { ActionProofService } from '../auth/action-proof.service.js';
import { WECHAT_ADAPTER } from '../wechat/wechat-adapter.js';
import type { WechatAdapter } from '../wechat/wechat-adapter.js';
import { IdentityService } from './identity.service.js';
import { MergesService } from './merges.service.js';
function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new AppError(422, 'VALIDATION_ERROR', '请求字段不符合要求。');
  return parsed.data;
}
function actor(request: Request): Actor {
  if (!request.actor) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
  return request.actor;
}
@ApiTags('identity')
@Controller()
export class IdentityController {
  constructor(
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(MergesService) private readonly merges: MergesService,
    @Inject(ActionProofService) private readonly proofs: ActionProofService,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WECHAT_ADAPTER) private readonly wechat: WechatAdapter,
  ) {}
  private async freshWechat(code: string) {
    try {
      return await this.wechat.exchangeCode(code);
    } catch (error) {
      if (error instanceof AppError && error.getStatus() === 401)
        throw new AppError(
          403,
          'REAUTH_REQUIRED',
          '新微信验证未通过，当前会话仍有效。',
        );
      throw error;
    }
  }
  private async attempt<T>(
    request: Request,
    scope: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const ip = request.ip ?? 'unknown',
      userId = actor(request).userId;
    this.security.checkFailures(scope, ip, userId, request.res);
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError && error.code === 'REAUTH_REQUIRED')
        this.security.failure(scope, ip, userId);
      throw error;
    }
  }

  @ApiOperation({
    summary:
      '以当前密码或 fresh 微信 code 验证当前身份，签发指定用途五分钟 proof',
  })
  @ApiBody({ schema: dtoSchema(reauthSchema) })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(actionProofDtoSchema),
  })
  @Post('auth/reauth')
  @HttpCode(200)
  @AllowPendingDeletion()
  async reauth(@Body() body: unknown, @Req() request: Request) {
    const input = parse(reauthSchema, body),
      current = actor(request);
    if (input.purpose === 'bind_email')
      input.target = parse(realEmailSchema, input.target);
    return this.attempt(request, 'reauth', async () => {
      if (!input.code)
        return await this.identity.passwordReauth(current, input);
      const wx = await this.freshWechat(input.code);
      return await this.db.transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${current.userId}::uuid FOR UPDATE`;
        const user = await this.proofs.current(tx, current, true);
        this.proofs.assertPurpose(user.status, input);
        if (
          !(await tx.wechatIdentity.findFirst({
            where: {
              userId: current.userId,
              appId: wx.appId,
              openid: wx.openid,
            },
          }))
        )
          throw new AppError(
            403,
            'REAUTH_REQUIRED',
            '新微信身份与当前账号不符，当前会话仍有效。',
          );
        return this.proofs.issue(current, input);
      });
    });
  }
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(emailBindingListSchema),
  })
  @Get('me/email-binding-requests')
  async emails(@Req() request: Request) {
    const current = actor(request);
    return this.db.emailBindingRequest.findMany({
      where: {
        userId: current.userId,
        status: { in: ['pending', 'verified'] },
      },
      select: {
        id: true,
        operationId: true,
        email: true,
        status: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  @Post('me/wechat-binding')
  @HttpCode(200)
  async bindWechat(@Body() body: unknown, @Req() request: Request) {
    const input = parse(
      z
        .object({
          code: z.string().min(1).max(512),
          operationId: z.uuid(),
          proof: z.string().max(4096),
        })
        .strict(),
      body,
    );
    return this.identity.bindWechat(
      actor(request),
      await this.freshWechat(input.code),
      input.operationId,
      input.proof,
    );
  }
  @ApiBody({ schema: dtoSchema(emailBindingCreateSchema) })
  @ApiResponse({ status: 202, schema: dataResponseSchema(bindingResultSchema) })
  @Post('me/email-binding-requests')
  @HttpCode(202)
  requestEmail(@Body() body: unknown, @Req() request: Request) {
    const input = parse(emailBindingCreateSchema, body);
    return this.identity.requestEmail(
      actor(request),
      input.email,
      input.operationId,
      input.proof,
    );
  }
  @ApiOperation({ summary: '匿名邮件链接只标记控制权，不登录或关联身份' })
  @ApiBody({ schema: dtoSchema(emailBindingVerifySchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(successDtoSchema) })
  @Post('me/email-binding-requests/verify')
  @Public()
  @HttpCode(200)
  verifyEmail(@Body() body: unknown) {
    const input = parse(emailBindingVerifySchema, body);
    return this.identity.verifyEmail(input.id, input.token);
  }
  @ApiBody({ schema: dtoSchema(emailBindingCompleteSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(bindingResultSchema) })
  @Post('me/email-binding-requests/:id/complete')
  @HttpCode(200)
  completeEmail(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.attempt(request, 'binding-email', () =>
      this.identity.completeEmail(
        actor(request),
        parse(z.uuid(), id),
        parse(emailBindingCompleteSchema, body),
      ),
    );
  }
  @Delete('me/email-binding-requests/:id')
  @HttpCode(200)
  cancelEmail(@Param('id') id: string, @Req() request: Request) {
    return this.identity.cancelEmail(actor(request), parse(z.uuid(), id));
  }
  @ApiBody({ schema: dtoSchema(mergePreviewInputSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergePlanSchema) })
  @Post('account-merges/preview')
  @HttpCode(200)
  preview(@Body() body: unknown, @Req() request: Request) {
    const input = parse(mergePreviewInputSchema, body);
    return this.merges.preview(
      actor(request),
      input.contextId,
      input.operationId,
    );
  }
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergeListSchema) })
  @Get('account-merges')
  list(@Req() request: Request) {
    return this.merges.list(actor(request));
  }
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergePlanSchema) })
  @Get('account-merges/:id')
  get(@Param('id') id: string, @Req() request: Request) {
    return this.merges.get(actor(request), parse(z.uuid(), id));
  }
  @ApiBody({ schema: dtoSchema(mergeReviewSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergePlanSchema) })
  @Post('account-merges/:id/review')
  @HttpCode(200)
  review(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.merges.review(
      actor(request),
      parse(z.uuid(), id),
      parse(mergeReviewSchema, body),
    );
  }
  @ApiBody({ schema: dtoSchema(mergeCommitSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergePlanSchema) })
  @Post('account-merges/:id/commit')
  @HttpCode(200)
  async commit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const result = await this.merges.commit(
      actor(request),
      parse(z.uuid(), id),
      parse(mergeCommitSchema, body),
    );
    if (result.result) request.committedDataVersion = result.result.dataVersion;
    return result;
  }
  @Delete('account-merges/:id')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() request: Request) {
    return this.merges.cancel(actor(request), parse(z.uuid(), id));
  }
  @ApiOperation({
    summary: '重新验证统一账号后取得来源草稿映射；proof只放body',
  })
  @ApiResponse({ status: 200, schema: dataResponseSchema(mergeMappingsSchema) })
  @Post('account-merges/:id/mappings')
  @HttpCode(200)
  mappings(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const input = parse(
      z.object({ proof: z.string().max(4096), operationId: z.uuid() }).strict(),
      body,
    );
    return this.merges.mappings(
      actor(request),
      parse(z.uuid(), id),
      input.proof,
      input.operationId,
    );
  }
}

import { msg } from '@dayline/locales';
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
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  actionProofDtoSchema,
  bindingResultSchema,
  realEmailSchema,
  qrConfirmSchema,
  qrCreateSchema,
  qrResolveSchema,
  wechatLoginSchema,
  qrStatusDtoSchema,
  qrCreatedDtoSchema,
  qrResolvedDtoSchema,
  wechatLoginDtoSchema,
} from '@dayline/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import { AuthAccessService } from '../auth/auth-access.service.js';
import { Public } from '../auth/auth.decorators.js';
import { AuthAdapter } from '../auth/adapter/auth-adapter.js';
import { forwardSessionHeaders } from '../auth/session-headers.js';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { dataResponseSchema, dtoSchema } from '../common/openapi.js';
import { AppError } from '../common/app-error.js';
import { UsersService } from '../users/users.service.js';
import { WECHAT_ADAPTER } from './wechat-adapter.js';
import type { WechatAdapter } from './wechat-adapter.js';
import { WechatService } from './wechat.service.js';
import { QrService } from './qr.service.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError(
      400,
      'INVALID_REQUEST',
      msg('errors.theRequestParametersDoNotMeetThe'),
    );
  return result.data;
}

@ApiTags('wechat-auth')
@Controller('auth')
@Public()
export class WechatController {
  private readonly rateBuckets = new Map<
    string,
    { start: number; count: number }
  >();
  constructor(
    @Inject(WECHAT_ADAPTER) private readonly wechat: WechatAdapter,
    @Inject(WechatService) private readonly identities: WechatService,
    @Inject(AuthAdapter) private readonly auth: AuthAdapter,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(QrService) private readonly qr: QrService,
    @Inject(AuthAccessService) private readonly access: AuthAccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private protect(request: Request, response: Response, browser = false) {
    if (
      (browser && !request.headers.origin) ||
      (request.headers.origin &&
        !this.config.trustedOrigins.includes(request.headers.origin))
    )
      throw new AppError(
        403,
        'UNTRUSTED_ORIGIN',
        msg('errors.theRequestSourceIsNotAllowed'),
      );
    if (this.config.environment === 'test') return;
    const now = Date.now();
    for (const [key, value] of this.rateBuckets)
      if (now - value.start >= 60_000) this.rateBuckets.delete(key);
    const key = `${request.ip}:${request.method}:${request.route?.path ?? 'auth'}`;
    const bucket = this.rateBuckets.get(key) ?? { start: now, count: 0 };
    bucket.count++;
    if (
      bucket.count > (request.method === 'GET' ? 90 : 30) ||
      this.rateBuckets.size >= 10_000
    ) {
      response.setHeader('Retry-After', '60');
      throw new AppError(
        429,
        'RATE_LIMITED',
        msg('errors.theOperationIsTooFrequentPleaseTry'),
      );
    }
    this.rateBuckets.set(key, bucket);
  }

  private browserSecret(request: Request, id: string) {
    const prefix = `dayline_qr_${id}=`;
    return (
      request.headers.cookie
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))
        ?.slice(prefix.length) ?? ''
    );
  }
  private requestId(id: string) {
    return parse(z.uuid(), id);
  }

  @Post('wechat/login')
  @HttpCode(200)
  @ApiOperation({ summary: '使用临时微信 code 登录，不接收 OpenID' })
  @ApiBody({ schema: dtoSchema(wechatLoginSchema) })
  @ApiResponse({
    status: 200,
    description:
      '公开 UserDto、expiresAt；签名凭据仅在 set-auth-token 响应头中',
    schema: dataResponseSchema(wechatLoginDtoSchema),
  })
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response);
    const { code } = parse(wechatLoginSchema, body);
    const userId = await this.identities.findOrCreate(
      await this.wechat.exchangeCode(code),
    );
    const session = await this.auth.createWechatSession(userId);
    forwardSessionHeaders(response, session.headers);
    return {
      user: await this.users.read(userId),
      expiresAt: session.expiresAt,
    };
  }

  @Post('qr-requests')
  @HttpCode(201)
  @ApiOperation({
    summary: '创建登录、绑定微信或专用重新验证小程序码；后两者固定当前会话',
  })
  @ApiBody({ schema: dtoSchema(qrCreateSchema) })
  @ApiResponse({
    status: 201,
    description: '浏览器 secret 为专用 HttpOnly Cookie',
    schema: dataResponseSchema(qrCreatedDtoSchema),
  })
  async create(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response, true);
    const input = parse(qrCreateSchema, body);
    if (input.action?.purpose === 'bind_email')
      input.action.target = parse(realEmailSchema, input.action.target);
    const session =
      input.purpose === 'login'
        ? null
        : await this.access.require(
            fromNodeHeaders(request.headers),
            'POST',
            input.purpose === 'reauth',
          );
    const result = await this.qr.create(
      input.id,
      input.purpose,
      session?.actor,
      input.action,
    );
    response.cookie(`dayline_qr_${input.id}`, result.secret, {
      httpOnly: true,
      secure: this.config.environment === 'production',
      sameSite: 'lax',
      maxAge: 120_000,
      path: `/api/v1/auth/qr-requests/${input.id}`,
    });
    return result.data;
  }

  @Post('qr-requests/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: '解析 scene 并验证微信；仅进入 scanned，不登录或建号',
  })
  @ApiBody({ schema: dtoSchema(qrResolveSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(qrResolvedDtoSchema) })
  async resolve(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response);
    const { scene, code } = parse(qrResolveSchema, body);
    return this.qr.resolve(scene, code);
  }

  @Post('qr-requests/:id/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: '扫码者明确确认本次登录、绑定或重新验证；不替换已固定意图',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ schema: dtoSchema(qrConfirmSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(qrStatusDtoSchema) })
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response);
    return this.qr.confirm(
      this.requestId(id),
      parse(qrConfirmSchema, body).scannerProof,
    );
  }

  @Get('qr-requests/:id')
  @ApiOperation({ summary: '使用原浏览器 HttpOnly secret 查询有限扫码状态' })
  @ApiResponse({ status: 200, schema: dataResponseSchema(qrStatusDtoSchema) })
  async status(
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response);
    return this.qr.status(this.requestId(id), this.browserSecret(request, id));
  }

  @Post('qr-requests/:id/consume')
  @HttpCode(200)
  @ApiOperation({
    summary: '原浏览器一次性领取对应目的的登录会话、短期操作证明或绑定结果',
  })
  @ApiResponse({
    status: 200,
    description:
      '仅 login 建立登录会话；reauth 只返回短期 purpose proof；bind 只返回绑定或受证合并上下文，不切换为扫码账号。',
    schema: {
      oneOf: [
        dataResponseSchema(wechatLoginDtoSchema),
        dataResponseSchema(actionProofDtoSchema),
        dataResponseSchema(bindingResultSchema),
      ],
    },
  })
  async consume(
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protect(request, response, true);
    const status = await this.qr.status(
      this.requestId(id),
      this.browserSecret(request, id),
    );
    if (status.purpose !== 'login') {
      const session = await this.access.require(
        fromNodeHeaders(request.headers),
        'POST',
        status.purpose === 'reauth',
      );
      return this.qr.consumeAction(
        this.requestId(id),
        this.browserSecret(request, id),
        session.actor,
      );
    }
    const userId = await this.qr.consume(
      this.requestId(id),
      this.browserSecret(request, id),
    );
    const session = await this.auth.createWechatSession(userId);
    forwardSessionHeaders(response, session.headers);
    return {
      user: await this.users.read(userId),
      expiresAt: session.expiresAt,
    };
  }

  @Delete('qr-requests/:id')
  @HttpCode(200)
  @ApiOperation({ summary: '原浏览器或本请求扫码者取消未消费请求' })
  @ApiHeader({ name: 'X-Dayline-Scanner-Proof', required: false })
  @ApiResponse({ status: 200, schema: dataResponseSchema(qrStatusDtoSchema) })
  async cancel(
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const proof = request.get('X-Dayline-Scanner-Proof');
    if (proof) parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), proof);
    this.protect(request, response, !proof);
    return this.qr.cancel(
      this.requestId(id),
      this.browserSecret(request, id),
      proof,
    );
  }
}

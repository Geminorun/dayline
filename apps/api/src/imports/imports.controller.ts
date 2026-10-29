import { msg } from '@dayline/locales';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  guestAdmissionSchema,
  importReviewSchema,
  importCommitSchema,
  importJobSchema,
} from '@dayline/contracts';
import { parseImportFile, FileError } from '@dayline/contracts/files';
import { AppError } from '../common/app-error.js';
import { dtoSchema, dataResponseSchema } from '../common/openapi.js';
import { Clock } from '../records/clock.js';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { ImportsService } from './imports.service.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      422,
      'IMPORT_INVALID',
      msg('errors.incorrectAccessFormatQuantityOrReference'),
      {
        issues: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
    );
  return result.data;
}
function actor(request: Request) {
  if (!request.actor)
    throw new AppError(401, 'UNAUTHENTICATED', msg('errors.pleaseLogInFirst'));
  return request.actor;
}
@ApiTags('imports')
@Controller()
export class ImportsController {
  constructor(
    @Inject(ImportsService) private readonly imports: ImportsService,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  private readonly previewBuckets = new Map<
    string,
    { start: number; count: number }
  >();
  private protectPreview(request: Request, response: Response) {
    if (this.config.environment === 'test') return;
    const now = this.clock.now().getTime();
    for (const [key, value] of this.previewBuckets)
      if (now - value.start >= 60000) this.previewBuckets.delete(key);
    const key = actor(request).userId,
      bucket = this.previewBuckets.get(key) ?? { start: now, count: 0 };
    if (
      bucket.count >= 5 ||
      (!this.previewBuckets.has(key) && this.previewBuckets.size >= 10000)
    ) {
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil((60000 - (now - bucket.start)) / 1000))),
      );
      throw new AppError(
        429,
        'RATE_LIMITED',
        msg('errors.previewingTooFrequentlyPleaseTryAgainLater'),
      );
    }
    bucket.count++;
    this.previewBuckets.set(key, bucket);
  }
  private async result(
    request: Request,
    result: Promise<z.infer<typeof importJobSchema>>,
  ) {
    const job = await result;
    if (job.result) request.committedDataVersion = job.result.dataVersion;
    return job;
  }
  @Post('guest-admissions/prepare')
  @ApiBody({ schema: dtoSchema(guestAdmissionSchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(importJobSchema) })
  prepare(@Req() request: Request, @Body() body: unknown) {
    return this.result(
      request,
      this.imports.prepare(actor(request), parse(guestAdmissionSchema, body)),
    );
  }
  @Post('imports/preview')
  @ApiBody({
    schema: { type: 'string', format: 'binary' },
    description:
      'Raw UTF-8 CSV/JSON, maximum 10 MiB. X-Dayline-File-Format: csv|json; X-Dayline-Operation-ID: UUID.',
  })
  @ApiResponse({ status: 201, schema: dataResponseSchema(importJobSchema) })
  preview(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.protectPreview(request, response);
    const format = parse(
      z.enum(['csv', 'json']),
      request.get('X-Dayline-File-Format'),
    );
    const operation = parse(z.uuid(), request.get('X-Dayline-Operation-ID'));
    if (!Buffer.isBuffer(body))
      throw new AppError(
        422,
        'IMPORT_INVALID',
        msg('errors.pleaseSelectAUtf8File'),
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new AppError(
        422,
        'IMPORT_INVALID',
        msg('errors.fileMustBeValidUtf8'),
      );
    }
    try {
      const source = parseImportFile(
        text,
        format,
        this.clock.now().toISOString(),
      );
      return this.result(
        request,
        this.imports.prepareNormalized(
          actor(request),
          format,
          operation,
          source,
        ),
      );
    } catch (error) {
      if (error instanceof FileError)
        throw new AppError(
          error.code === 'FILE_TOO_LARGE' ? 413 : 422,
          error.code,
          error.message,
          { issues: error.issues },
        );
      throw error;
    }
  }
  @Get('imports/by-operation/:operationId')
  @ApiResponse({ status: 200, schema: dataResponseSchema(importJobSchema) })
  byOperation(@Req() request: Request, @Param('operationId') id: string) {
    return this.result(
      request,
      this.imports.get(actor(request), parse(z.uuid(), id), true),
    );
  }
  @Get('imports/:id')
  @ApiResponse({ status: 200, schema: dataResponseSchema(importJobSchema) })
  get(@Req() request: Request, @Param('id') id: string) {
    return this.result(
      request,
      this.imports.get(actor(request), parse(z.uuid(), id)),
    );
  }
  @Post('imports/:id/review')
  @ApiBody({ schema: dtoSchema(importReviewSchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(importJobSchema) })
  review(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.result(
      request,
      this.imports.review(
        actor(request),
        parse(z.uuid(), id),
        parse(importReviewSchema, body),
      ),
    );
  }
  @Post('imports/:id/commit')
  @ApiBody({ schema: dtoSchema(importCommitSchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(importJobSchema) })
  commit(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.result(
      request,
      this.imports.commit(
        actor(request),
        parse(z.uuid(), id),
        parse(importCommitSchema, body),
      ),
    );
  }
  @Delete('imports/:id')
  @ApiResponse({ status: 200, schema: dataResponseSchema(importJobSchema) })
  cancel(@Req() request: Request, @Param('id') id: string) {
    return this.result(
      request,
      this.imports.cancel(actor(request), parse(z.uuid(), id)),
    );
  }
}

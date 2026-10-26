import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  guestAdmissionSchema,
  importReviewSchema,
  importCommitSchema,
  importJobSchema,
} from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import { dtoSchema, dataResponseSchema } from '../common/openapi.js';
import { ImportsService } from './imports.service.js';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(422, 'IMPORT_INVALID', '接入格式、数量或引用不正确。', {
      issues: result.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
      })),
    });
  return result.data;
}
function actor(request: Request) {
  if (!request.actor) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
  return request.actor;
}
@ApiTags('imports')
@Controller()
export class ImportsController {
  constructor(
    @Inject(ImportsService) private readonly imports: ImportsService,
  ) {}
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

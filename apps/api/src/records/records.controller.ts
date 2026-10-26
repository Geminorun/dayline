import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  categoryDtoSchema,
  categoryResultSchema,
  createCategorySchema,
  patchCategorySchema,
  deleteCategorySchema,
  createEntrySchema,
  entryResultSchema,
  patchEntrySchema,
  expectedVersionSchema,
  setFocusSchema,
  focusResultSchema,
  purgeTrashSchema,
  snapshotDtoSchema,
  entryDtoSchema,
  dateSchema,
  successDtoSchema,
} from '@dayline/contracts';
import { AppError } from '../common/app-error.js';
import { dataResponseSchema, dtoSchema } from '../common/openapi.js';
import { RecordsService } from './records.service.js';
function actor(request: Request) {
  if (!request.actor) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
  return request.actor;
}
function parse<T>(schema: z.ZodType<T>, value: unknown, path = false): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      path ? 400 : 422,
      path ? 'INVALID_INPUT' : 'VALIDATION_ERROR',
      '输入格式不正确，请检查日期、长度和必填项。',
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    );
  return result.data;
}
const id = (value: string) => parse(z.uuid(), value, true);
@ApiTags('records')
@Controller()
export class RecordsController {
  constructor(
    @Inject(RecordsService) private readonly records: RecordsService,
  ) {}
  private async written<T>(
    request: Request,
    result: Promise<{ data: T; dataVersion: string }>,
  ) {
    const committed = await result;
    request.committedDataVersion = committed.dataVersion;
    return committed.data;
  }
  @Get('categories')
  @ApiOperation({ summary: '读取全部分类' })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(z.array(categoryDtoSchema)),
  })
  categories(@Req() request: Request) {
    return this.records.categories(actor(request).userId);
  }
  @Post('categories')
  @ApiOperation({ summary: '稳定 ID 新建分类' })
  @ApiBody({ schema: dtoSchema(createCategorySchema) })
  @ApiResponse({
    status: 201,
    schema: dataResponseSchema(categoryResultSchema),
  })
  createCategory(@Req() request: Request, @Body() body: unknown) {
    return this.written(
      request,
      this.records.createCategory(
        actor(request),
        parse(createCategorySchema, body),
      ),
    );
  }
  @Patch('categories/:id')
  @ApiOperation({ summary: '按版本更新分类' })
  @ApiBody({ schema: dtoSchema(patchCategorySchema) })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(categoryResultSchema),
  })
  patchCategory(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.patchCategory(
        actor(request),
        id(value),
        parse(patchCategorySchema, body),
      ),
    );
  }
  @Delete('categories/:id')
  @ApiOperation({ summary: '原子转移事项并删除分类' })
  @ApiBody({ schema: dtoSchema(deleteCategorySchema) })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(
      successDtoSchema.extend({ transferredCount: z.number().int() }),
    ),
  })
  deleteCategory(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.deleteCategory(
        actor(request),
        id(value),
        parse(deleteCategorySchema, body),
      ),
    );
  }
  @Post('entries')
  @ApiOperation({ summary: '稳定 ID 新建事项' })
  @ApiBody({ schema: dtoSchema(createEntrySchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(entryResultSchema) })
  createEntry(@Req() request: Request, @Body() body: unknown) {
    return this.written(
      request,
      this.records.createEntry(actor(request), parse(createEntrySchema, body)),
    );
  }
  @Get('entries/:id')
  @ApiOperation({ summary: '读取事项及全部重点状态' })
  @ApiResponse({ status: 200, schema: dataResponseSchema(entryResultSchema) })
  entry(@Req() request: Request, @Param('id') value: string) {
    return this.records.readEntry(actor(request).userId, id(value));
  }
  @Patch('entries/:id')
  @ApiOperation({ summary: '按版本修改事项及必要的重点移除确认' })
  @ApiBody({ schema: dtoSchema(patchEntrySchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(entryResultSchema) })
  patchEntry(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.patchEntry(
        actor(request),
        id(value),
        parse(patchEntrySchema, body),
      ),
    );
  }
  @Post('entries/:id/finish')
  @ApiOperation({ summary: '按北京时间今天结束事项' })
  @ApiBody({ schema: dtoSchema(expectedVersionSchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(entryResultSchema) })
  finish(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.finish(
        actor(request),
        id(value),
        parse(expectedVersionSchema, body).expectedVersion,
      ),
    );
  }
  @Delete('entries/:id')
  @ApiOperation({ summary: '移入 30 天回收站' })
  @ApiBody({ schema: dtoSchema(expectedVersionSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(entryResultSchema) })
  deleteEntry(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.deleteEntry(
        actor(request),
        id(value),
        parse(expectedVersionSchema, body).expectedVersion,
      ),
    );
  }
  @Put('entries/:id/focus-days/:date')
  @ApiOperation({ summary: '按单日版本设置明确重点状态' })
  @ApiBody({ schema: dtoSchema(setFocusSchema) })
  @ApiResponse({ status: 200, schema: dataResponseSchema(focusResultSchema) })
  focus(
    @Req() request: Request,
    @Param('id') value: string,
    @Param('date') date: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.setFocus(
        actor(request),
        id(value),
        parse(dateSchema, date, true),
        parse(setFocusSchema, body),
      ),
    );
  }
  @Get('trash')
  @ApiOperation({ summary: '读取仍可恢复的回收站事项' })
  @ApiResponse({
    status: 200,
    schema: dataResponseSchema(z.array(entryDtoSchema)),
  })
  trash(@Req() request: Request) {
    return this.records.trash(actor(request).userId);
  }
  @Post('trash/:id/restore')
  @ApiOperation({ summary: '恢复期限内的事项与重点' })
  @ApiBody({ schema: dtoSchema(expectedVersionSchema) })
  @ApiResponse({ status: 201, schema: dataResponseSchema(entryResultSchema) })
  restore(
    @Req() request: Request,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.written(
      request,
      this.records.restore(
        actor(request),
        id(value),
        parse(expectedVersionSchema, body).expectedVersion,
      ),
    );
  }
  @Post('trash/purge')
  @ApiOperation({ summary: '确认版本后永久清理选中项或全部回收站' })
  @ApiBody({ schema: dtoSchema(purgeTrashSchema) })
  @ApiResponse({
    status: 201,
    schema: dataResponseSchema(
      successDtoSchema.extend({ purgedCount: z.number().int() }),
    ),
  })
  purge(@Req() request: Request, @Body() body: unknown) {
    return this.written(
      request,
      this.records.purge(actor(request), parse(purgeTrashSchema, body)),
    );
  }
  @Get('snapshot')
  @ApiOperation({ summary: '一致完整快照；先鉴权后评估 ETag' })
  @ApiResponse({ status: 200, schema: dataResponseSchema(snapshotDtoSchema) })
  @ApiResponse({ status: 304, description: '当前用户的完整快照未变化' })
  async snapshot(
    @Req() request: Request,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const snapshot = await this.records.snapshot(actor(request), ifNoneMatch);
    response.setHeader('ETag', snapshot.etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    response.vary('Cookie');
    response.vary('Authorization');
    if (!snapshot.data) {
      response.status(304);
      return undefined;
    }
    return snapshot.data;
  }
}

import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { csvTemplate, exportCsv, exportJson } from '@dayline/contracts/files';
import { Public, AllowPendingDeletion } from '../auth/auth.decorators.js';
import { Clock } from '../records/clock.js';
import { RecordsService } from '../records/records.service.js';
import { AppError } from '../common/app-error.js';
@ApiTags('exports')
@Controller('exports')
export class ExportsController {
  constructor(
    @Inject(RecordsService) private readonly records: RecordsService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}
  private send(
    response: Response,
    format: 'csv' | 'json',
    text: string,
    template = false,
  ) {
    response.setHeader(
      'Content-Type',
      format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/json; charset=utf-8',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="dayline-${template ? 'template' : this.clock.now().toISOString().slice(0, 10)}.${format}"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.vary('Cookie');
    response.vary('Authorization');
    response.send(text);
  }
  @Get('csv-template')
  @Public()
  @ApiProduces('text/csv')
  template(@Res() response: Response) {
    this.send(response, 'csv', csvTemplate(), true);
  }
  private async data(request: Request) {
    if (!request.actor)
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    const { data } = await this.records.snapshot(request.actor);
    if (!data) throw new AppError(503, 'EXPORT_UNAVAILABLE', '请稍后重试。');
    return {
      categories: data.categories,
      entries: [...data.entries, ...data.trashEntries],
      focusDays: data.focusDays,
    };
  }
  @Get('csv')
  @AllowPendingDeletion()
  @ApiProduces('text/csv')
  async csv(@Req() request: Request, @Res() response: Response) {
    this.send(response, 'csv', exportCsv(await this.data(request)));
  }
  @Get('json')
  @AllowPendingDeletion()
  @ApiProduces('application/json')
  async json(@Req() request: Request, @Res() response: Response) {
    this.send(
      response,
      'json',
      exportJson(await this.data(request), this.clock.now().toISOString()),
    );
  }
}

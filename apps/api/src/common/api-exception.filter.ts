import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorResult } from '@dayline/contracts';
import { AppError } from './app-error.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务暂时不可用，请稍后重试。';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'RESOURCE_NOT_FOUND' : 'HTTP_ERROR';
      message = status < 500 ? exception.message : message;
    } else if (
      exception instanceof Error &&
      'status' in exception &&
      typeof exception.status === 'number'
    ) {
      if ([400, 413, 415].includes(exception.status)) {
        status = exception.status;
        code = 'INVALID_REQUEST';
        message = '请求格式或大小不符合要求。';
      }
    }

    if (status >= 500) {
      this.logger.error({
        message: 'Request failed',
        requestId: request.requestId,
        errorType: exception instanceof Error ? exception.name : 'unknown',
      });
    }
    const body: ApiErrorResult = {
      error: { code, message, ...(details === undefined ? {} : { details }) },
      meta: {
        requestId: request.requestId,
        serverTime: new Date().toISOString(),
      },
    };
    response.status(status).json(body);
  }
}

import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiResult } from '@dayline/contracts';

@Injectable()
export class ApiResultInterceptor implements NestInterceptor<
  unknown,
  ApiResult<unknown>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResult<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      map((data: unknown) => ({
        data,
        meta: {
          requestId: request.requestId,
          ...(request.committedDataVersion
            ? { dataVersion: request.committedDataVersion }
            : {}),
          serverTime: new Date().toISOString(),
        },
      })),
    );
  }
}

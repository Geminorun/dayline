import { HttpException } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    cause?: unknown,
  ) {
    super(message, status, cause === undefined ? undefined : { cause });
  }
}

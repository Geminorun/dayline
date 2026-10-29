import { diagnosticMessage, fallbackText } from '@dayline/locales';
import { HttpException } from '@nestjs/common';

import type { Message, UiText } from '@dayline/locales';

export class AppError extends HttpException {
  readonly localized?: Message;
  constructor(
    status: number,
    readonly code: string,
    message: UiText,
    readonly details?: unknown,
    cause?: unknown,
  ) {
    const localized = diagnosticMessage(message);
    super(
      fallbackText(localized),
      status,
      cause === undefined ? undefined : { cause },
    );
    if (typeof localized !== 'string') this.localized = localized;
  }
}

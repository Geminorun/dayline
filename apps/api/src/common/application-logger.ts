import { ConsoleLogger } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';
import type { AppConfig } from '../config/environment.js';
import { errorDiagnostics, sanitizeStack } from './error-diagnostics.js';
import { requestBudget } from './request-budget.js';

export class ApplicationLogger extends ConsoleLogger {
  constructor(level: AppConfig['logLevel'] = 'info') {
    super({
      colors: false,
      compact: true,
      logLevels:
        level === 'error'
          ? ['fatal', 'error']
          : level === 'warn'
            ? ['fatal', 'error', 'warn']
            : ['fatal', 'error', 'warn', 'log'],
    });
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    level?: LogLevel,
    stream?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    // Nest may pass an exception message and stack as separate strings.
    const safe =
      typeof errorStack === 'string' && errorStack
        ? messages.map((message) =>
            typeof message === 'string' ? 'Unhandled exception' : message,
          )
        : messages;
    super.printMessages(safe, context, level, stream, errorStack);
  }

  protected override stringifyReplacer(key: string, value: unknown): unknown {
    if (
      /^(?:password|currentPassword|newPassword|confirmPassword|token|accessToken|refreshToken|authorization|cookie|set-cookie|secret|apiKey|databaseUrl|body|input|html|text|email|openid|unionid)$/i.test(
        key,
      )
    )
      return '[REDACTED]';
    return value instanceof Error
      ? errorDiagnostics(value)
      : super.stringifyReplacer(key, value);
  }

  protected override formatMessage(
    level: LogLevel,
    message: unknown,
    _pid: string,
    _level: string,
    context: string,
  ): string {
    const requestId = requestBudget.getStore()?.requestId;
    let stack: unknown;
    const safe = message instanceof Error ? errorDiagnostics(message) : message;
    let body: unknown = safe;
    if (safe && typeof safe === 'object' && 'stack' in safe) {
      const { stack: trace, ...fields } = safe;
      stack = trace;
      body = fields;
    }
    const text =
      typeof body === 'string'
        ? body
        : this.stringifyJsonLogObject({ ...asRecord(body) });
    const singleLine = text
      .replaceAll('\r', ' ')
      .replaceAll('\n', ' ')
      .replaceAll(String.fromCharCode(27), ' ');
    const heading = `${new Date().toISOString()} ${level === 'log' ? 'INFO' : level.toUpperCase()} ${process.pid} ${context || '[Application] '}${requestId ? `requestId=${requestId} ` : ''}${singleLine}\n`;
    return (
      heading + (typeof stack === 'string' ? `${sanitizeStack(stack)}\n` : '')
    );
  }

  protected override printStackTrace(stack?: string): void {
    if (stack) super.printStackTrace(sanitizeStack(stack));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : { message: value };
}

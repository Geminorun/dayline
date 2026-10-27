export interface ErrorDiagnostics {
  errorType: string;
  errorCode?: string;
  stack?: string;
}

const callSite =
  /^\s+at (?:async )?(?:[\w.$<>[\] ]+ \()?(?:\/?[\w./:@+-]+):\d+:\d+\)?$/;
const stableCode = /^(?:P\d{4}|E[A-Z_]{2,40}|[0-9A-Z]{5})$/;

function errorCode(cause: unknown): string | undefined {
  const code =
    cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && stableCode.test(code) ? code : undefined;
}

export function sanitizeStack(stack: string): string {
  return (
    stack
      .split('\n')
      .filter(
        (line) =>
          /^(?:Caused by: )?[\w.]{1,80}(?: \[(?:P\d{4}|E[A-Z_]{2,40}|[0-9A-Z]{5})\])?$/.test(
            line,
          ) || callSite.test(line),
      )
      .slice(0, 84)
      .join('\n') || 'Error'
  );
}

// Error messages (especially Prisma/SDK errors) may contain SQL, input or credentials.
// Keep types, stable codes and V8 call sites, never the message or arbitrary metadata.
export function errorDiagnostics(cause: unknown): ErrorDiagnostics {
  const seen = new Set<Error>();
  const stacks: string[] = [];
  let current = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const name = /^[\w.]{1,80}$/.test(current.name) ? current.name : 'Error';
    const code = errorCode(current);
    const frames = (current.stack ?? '')
      .split('\n')
      .filter((line) => callSite.test(line))
      .slice(0, 20);
    stacks.push(
      `${depth ? 'Caused by: ' : ''}${name}${code ? ` [${code}]` : ''}\n${frames.join('\n')}`.trimEnd(),
    );
    current = current.cause;
  }
  const code = errorCode(cause);
  return {
    errorType:
      cause instanceof Error && /^[\w.]{1,80}$/.test(cause.name)
        ? cause.name
        : 'UnknownError',
    ...(code ? { errorCode: code } : {}),
    ...(stacks.length ? { stack: stacks.join('\n') } : {}),
  };
}

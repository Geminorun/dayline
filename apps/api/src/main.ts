import { Logger } from '@nestjs/common';
import { createApp } from './app.factory.js';
import { loadEnvironment } from './config/environment.js';
import { ApplicationLogger } from './common/application-logger.js';
import { errorDiagnostics } from './common/error-diagnostics.js';

Logger.overrideLogger(new ApplicationLogger());

async function bootstrap(): Promise<void> {
  const config = loadEnvironment();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    {
      code: 'STARTUP_FAILED',
      message:
        error instanceof Error &&
        error.message.startsWith('Invalid configuration:')
          ? error.message
          : 'API startup failed. Check configuration, database and migrations.',
      ...errorDiagnostics(error),
    },
    'Bootstrap',
  );
  process.exitCode = 1;
});

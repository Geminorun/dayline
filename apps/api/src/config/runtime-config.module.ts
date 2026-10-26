import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_CONFIG } from './environment.js';
import type { AppConfig } from './environment.js';

@Global()
@Module({})
export class RuntimeConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: RuntimeConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

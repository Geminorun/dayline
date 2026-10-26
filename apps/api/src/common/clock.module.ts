import { Global, Module } from '@nestjs/common';
import { Clock } from '../records/clock.js';
@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}

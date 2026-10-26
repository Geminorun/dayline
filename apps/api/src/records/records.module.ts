import { Module } from '@nestjs/common';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';
import { ClockModule } from '../common/clock.module.js';
@Module({
  imports: [ClockModule],
  controllers: [RecordsController],
  providers: [RecordsService],
  exports: [ClockModule, RecordsService],
})
export class RecordsModule {}

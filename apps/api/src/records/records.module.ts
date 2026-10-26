import { Module } from '@nestjs/common';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';
import { Clock } from './clock.js';
@Module({
  controllers: [RecordsController],
  providers: [RecordsService, Clock],
})
export class RecordsModule {}

import { ExportsController } from './exports.controller.js';
import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';
import { RecordsModule } from '../records/records.module.js';
@Module({
  imports: [RecordsModule],
  controllers: [ImportsController, ExportsController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}

import { Global, Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service.js';
@Global()
@Module({ providers: [MaintenanceService], exports: [MaintenanceService] })
export class MaintenanceModule {}

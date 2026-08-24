import { Module } from '@nestjs/common';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [FrequenciaModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

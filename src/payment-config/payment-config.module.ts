import { Module } from '@nestjs/common';
import { CourtsModule } from '../courts/courts.module';
import { PaymentConfigController } from './payment-config.controller';
import { PaymentConfigService } from './payment-config.service';
import { PaymentStatusController } from './payment-status.controller';

@Module({
  imports: [CourtsModule],
  controllers: [PaymentConfigController, PaymentStatusController],
  providers: [PaymentConfigService],
})
export class PaymentConfigModule {}

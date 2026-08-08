import { Module } from '@nestjs/common';
import { SmokeController } from './smoke/smoke.controller';

@Module({
  controllers: [SmokeController],
})
export class CommonModule {}

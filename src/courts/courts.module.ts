import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';

@Module({
  controllers: [CourtsController, BookingsController],
  providers: [CourtsService],
  exports: [CourtsService],
})
export class CourtsModule {}

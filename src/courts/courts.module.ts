import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { BookingsController } from './bookings.controller';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';

@Module({
  imports: [PeopleModule],
  controllers: [CourtsController, BookingsController],
  providers: [CourtsService],
  exports: [CourtsService],
})
export class CourtsModule {}

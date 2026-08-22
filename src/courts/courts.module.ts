import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { BookingsController } from './bookings.controller';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';

@Module({
  imports: [PeopleModule],
  controllers: [CourtsController, BookingsController],
  providers: [CourtsService, HorarioFuncionamentoService],
  exports: [CourtsService, HorarioFuncionamentoService],
})
export class CourtsModule {}

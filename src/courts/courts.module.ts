import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { AgendaController } from './agenda.controller';
import { AgendaService } from './agenda.service';
import { BookingsController } from './bookings.controller';
import { CompanySettingsController } from './company-settings.controller';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';

@Module({
  imports: [PeopleModule],
  controllers: [
    CourtsController,
    BookingsController,
    CompanySettingsController,
    AgendaController,
  ],
  providers: [CourtsService, HorarioFuncionamentoService, AgendaService],
  exports: [CourtsService, HorarioFuncionamentoService],
})
export class CourtsModule {}

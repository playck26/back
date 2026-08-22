import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { BookingsController } from './bookings.controller';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';
import { CompanySettingsController } from './company-settings.controller';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';

@Module({
  imports: [PeopleModule],
  controllers: [
    CourtsController,
    BookingsController,
    CompanySettingsController,
  ],
  providers: [CourtsService, HorarioFuncionamentoService],
  exports: [CourtsService, HorarioFuncionamentoService],
})
export class CourtsModule {}

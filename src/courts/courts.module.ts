import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { StorageModule } from '../storage/storage.module';
import { AgendaController } from './agenda.controller';
import { AgendaService } from './agenda.service';
import { BookingsController } from './bookings.controller';
import { CompanySettingsController } from './company-settings.controller';
import { CourtsController } from './courts.controller';
import {
  CategoriasDeQuadraService,
  EsportesDeQuadraService,
} from './catalogos-de-quadra';
import {
  CourtCategoriesController,
  CourtSportsController,
} from './court-catalogs.controller';
import { CourtImageController } from './court-image.controller';
import { CourtsService } from './courts.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { ImagemDaQuadraService } from './imagem-da-quadra.service';
import { CompanySettingsModule } from '../company-settings/company-settings.module';

@Module({
  // StorageModule entra pela imagem de quadra (SPEC-018/TASK-005), pelo
  // mesmo caminho que a logo entrou em MOD-002.
  imports: [CompanySettingsModule, PeopleModule, StorageModule],
  controllers: [
    CourtsController,
    BookingsController,
    CompanySettingsController,
    AgendaController,
    CourtImageController,
    // SPEC-020/TASK-002 — os dois catalogos do clube.
    CourtSportsController,
    CourtCategoriesController,
  ],
  providers: [
    CourtsService,
    HorarioFuncionamentoService,
    AgendaService,
    ImagemDaQuadraService,
    EsportesDeQuadraService,
    CategoriasDeQuadraService,
  ],
  exports: [CourtsService, HorarioFuncionamentoService, ImagemDaQuadraService],
})
export class CourtsModule {}

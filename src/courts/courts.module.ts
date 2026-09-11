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
import { HorariosDeAulaParticularService } from './horarios-de-aula-particular.service';
import { MeHorariosDeAulaController } from './me-horarios-de-aula.controller';
import { ImagemDaQuadraService } from './imagem-da-quadra.service';
import { CompanySettingsModule } from '../company-settings/company-settings.module';
import { CreditosModule } from '../creditos/creditos.module';

@Module({
  // StorageModule entra pela imagem de quadra (SPEC-018/TASK-005), pelo
  // mesmo caminho que a logo entrou em MOD-002.
  imports: [
    CompanySettingsModule,
    PeopleModule,
    StorageModule,
    // SPEC-033/TASK-005: criar reserva debita e cancelar devolve, DENTRO da
    // mesma transacao -- sem isso haveria janela entre a reserva existir e o
    // dinheiro sair.
    CreditosModule,
  ],
  controllers: [
    CourtsController,
    BookingsController,
    CompanySettingsController,
    AgendaController,
    CourtImageController,
    // SPEC-020/TASK-002 — os dois catalogos do clube.
    CourtSportsController,
    CourtCategoriesController,
    // SPEC-047 — prefixo `me/professores`, mas mora aqui: ver o docstring do
    // controller. O contrario (rota em `PeopleModule`) seria import circular.
    MeHorariosDeAulaController,
  ],
  providers: [
    CourtsService,
    HorarioFuncionamentoService,
    HorariosDeAulaParticularService,
    AgendaService,
    ImagemDaQuadraService,
    EsportesDeQuadraService,
    CategoriasDeQuadraService,
  ],
  exports: [CourtsService, HorarioFuncionamentoService, ImagemDaQuadraService],
})
export class CourtsModule {}

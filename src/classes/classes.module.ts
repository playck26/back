import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { CourtsModule } from '../courts/courts.module';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { MeClassesController } from './me-classes.controller';
import { MeTeacherAttendanceController } from './me-teacher-attendance.controller';
import { MeTeacherClassesController } from './me-teacher-classes.controller';
import { AgendaDoProfessorService } from './agenda-do-professor.service';
import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';
import { MeTeacherAgendaController } from './me-teacher-agenda.controller';
import { MatriculaDoAlunoService } from './matricula-do-aluno.service';
import { PresencaService } from './presenca.service';
import { CompanySettingsModule } from '../company-settings/company-settings.module';
import { FaltaAvisadaService } from './falta-avisada.service';
import { MeReposicoesController } from './me-reposicoes.controller';
import { ReposicaoService } from './reposicao.service';
import { PresencaAutomaticaModule } from '../presenca-automatica/presenca-automatica.module';

@Module({
  imports: [
    CompanySettingsModule,
    CourtsModule,
    PeopleModule,
    FrequenciaModule,
    PresencaAutomaticaModule,
  ],
  controllers: [
    ClassesController,
    MeClassesController,
    MeTeacherClassesController,
    MeTeacherAttendanceController,
    MeTeacherAgendaController,
    MeReposicoesController,
  ],
  providers: [
    ReposicaoService,
    FaltaAvisadaService,
    ClassesService,
    AgendaDoProfessorService,
    AvaliacaoDeAulaService,
    MatriculaDoAlunoService,
    PresencaService,
  ],
  // SPEC-064 — a confirmação da fila de espera precisa matricular e criar
  // reposição DENTRO da transação dela (AC-007), então ela compõe os dois
  // serviços em vez de reescrever as regras. Só estes dois saem: o resto do
  // módulo continua sendo assunto interno.
  exports: [ReposicaoService, MatriculaDoAlunoService],
})
export class ClassesModule {}

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

@Module({
  imports: [
    CompanySettingsModule,
    CourtsModule,
    PeopleModule,
    FrequenciaModule,
  ],
  controllers: [
    ClassesController,
    MeClassesController,
    MeTeacherClassesController,
    MeTeacherAttendanceController,
    MeTeacherAgendaController,
  ],
  providers: [
    ClassesService,
    AgendaDoProfessorService,
    AvaliacaoDeAulaService,
    MatriculaDoAlunoService,
    PresencaService,
  ],
})
export class ClassesModule {}

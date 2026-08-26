import { Module } from '@nestjs/common';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { StorageModule } from '../storage/storage.module';
import { FotoDeProfessorService } from './foto-de-professor.service';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { TeacherPhotoController } from './teacher-photo.controller';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';

@Module({
  // StorageModule entra pela foto de professor (SPEC-018/TASK-004), pelo
  // mesmo caminho que a logo entrou em MOD-002 e a imagem de quadra em
  // MOD-004.
  imports: [FrequenciaModule, StorageModule],
  controllers: [
    StudentsController,
    TeachersController,
    TeacherPhotoController,
    LevelsController,
  ],
  providers: [
    StudentsService,
    TeachersService,
    LevelsService,
    FotoDeProfessorService,
  ],
  // SPEC-009/REQ-007: MOD-001 provisiona conta de aluno chamando o método
  // público de MOD-003, então o serviço precisa sair do módulo.
  exports: [StudentsService, FotoDeProfessorService],
})
export class PeopleModule {}

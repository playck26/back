import { Module } from '@nestjs/common';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';

@Module({
  imports: [FrequenciaModule],
  controllers: [StudentsController, TeachersController, LevelsController],
  providers: [StudentsService, TeachersService, LevelsService],
  // SPEC-009/REQ-007: MOD-001 provisiona conta de aluno chamando o método
  // público de MOD-003, então o serviço precisa sair do módulo.
  exports: [StudentsService],
})
export class PeopleModule {}

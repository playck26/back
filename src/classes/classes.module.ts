import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { CourtsModule } from '../courts/courts.module';
import { FrequenciaModule } from '../frequencia/frequencia.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { MeClassesController } from './me-classes.controller';
import { MeTeacherAttendanceController } from './me-teacher-attendance.controller';
import { MeTeacherClassesController } from './me-teacher-classes.controller';
import { PresencaService } from './presenca.service';

@Module({
  imports: [CourtsModule, PeopleModule, FrequenciaModule],
  controllers: [
    ClassesController,
    MeClassesController,
    MeTeacherClassesController,
    MeTeacherAttendanceController,
  ],
  providers: [ClassesService, PresencaService],
})
export class ClassesModule {}

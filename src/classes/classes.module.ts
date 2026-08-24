import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { CourtsModule } from '../courts/courts.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { MeClassesController } from './me-classes.controller';
import { MeTeacherAttendanceController } from './me-teacher-attendance.controller';
import { MeTeacherClassesController } from './me-teacher-classes.controller';
import { FrequenciaService } from './frequencia.service';
import { PresencaService } from './presenca.service';

@Module({
  imports: [CourtsModule, PeopleModule],
  controllers: [
    ClassesController,
    MeClassesController,
    MeTeacherClassesController,
    MeTeacherAttendanceController,
  ],
  providers: [ClassesService, PresencaService, FrequenciaService],
})
export class ClassesModule {}

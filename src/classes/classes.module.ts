import { Module } from '@nestjs/common';
import { PeopleModule } from '../people/people.module';
import { CourtsModule } from '../courts/courts.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { MeClassesController } from './me-classes.controller';
import { MeTeacherClassesController } from './me-teacher-classes.controller';

@Module({
  imports: [CourtsModule, PeopleModule],
  controllers: [
    ClassesController,
    MeClassesController,
    MeTeacherClassesController,
  ],
  providers: [ClassesService],
})
export class ClassesModule {}

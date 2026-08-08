import { Module } from '@nestjs/common';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { TeachersController } from './teachers.controller';
import { TeachersService } from './teachers.service';

@Module({
  controllers: [StudentsController, TeachersController, LevelsController],
  providers: [StudentsService, TeachersService, LevelsService],
})
export class PeopleModule {}

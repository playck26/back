import { Module } from '@nestjs/common';
import { CourtsModule } from '../courts/courts.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { MeClassesController } from './me-classes.controller';

@Module({
  imports: [CourtsModule],
  controllers: [ClassesController, MeClassesController],
  providers: [ClassesService],
})
export class ClassesModule {}

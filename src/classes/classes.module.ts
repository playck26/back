import { Module } from '@nestjs/common';
import { CourtsModule } from '../courts/courts.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';

@Module({
  imports: [CourtsModule],
  controllers: [ClassesController],
  providers: [ClassesService],
})
export class ClassesModule {}

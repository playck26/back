import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { ClassesService } from './classes.service';

// CON-004.5 (SPEC-005) — exclusivo do aluno, separado do CRUD
// administrativo de turmas em ClassesController (company_admin).
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/classes')
export class MeClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Get()
  @Roles('aluno')
  myUpcomingClasses(@CurrentUser() user: AccessTokenPayload) {
    return this.classesService.myUpcomingClasses(
      user.companyId as string,
      user.sub,
    );
  }
}

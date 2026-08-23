import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { ClassesService } from './classes.service';

/**
 * SPEC-013 — leitura do professor, separada tanto do CRUD administrativo
 * (`ClassesController`, company_admin) quanto da visao do aluno
 * (`MeClassesController`). Tres publicos, tres controllers: o mesmo recurso
 * com escopo e campos diferentes, e misturar isso num controller so foi
 * como surgiram os vazamentos que a SPEC-012 teve de corrigir.
 *
 * So GET. O professor nao cria, nao edita e nao cancela nada.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/teacher/classes')
export class MeTeacherClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Get()
  @Roles('professor')
  minhasTurmas(@CurrentUser() user: AccessTokenPayload) {
    return this.classesService.myTeachingClasses(
      user.companyId as string,
      user.sub,
    );
  }

  @Get(':id')
  @Roles('professor')
  detalhe(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.classesService.myTeachingClassDetail(
      user.companyId as string,
      user.sub,
      id,
    );
  }
}

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AgendaDoProfessorService } from './agenda-do-professor.service';
import {
  AulaDoDiaDoProfessorDto,
  DiaDaAgendaDoProfessorDto,
} from './dto/agenda-do-professor.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  AgendaDoProfessorQueryDto,
  DataDaAgendaParamDto,
} from './dto/agenda-do-professor-query.dto';

/**
 * SPEC-026 — **o calendário do professor.**
 *
 * A entrada pelo DIA, que era a metade que faltava do pedido do Israel
 * ("Calendário → Turma → Alunos → Presença"). A outra metade — a cadeia da
 * chamada — já está no ar desde a SPEC-014, e é para ela que estas rotas
 * levam.
 *
 * Controller separado do de chamada porque são momentos diferentes: aqui ele
 * **procura** o dia; lá ele **registra** a aula.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/teacher/agenda')
export class MeTeacherAgendaController {
  constructor(private readonly agenda: AgendaDoProfessorService) {}

  @Get()
  @ApiOkResponse({ type: [DiaDaAgendaDoProfessorDto] })
  @Roles('professor')
  resumoDoMes(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: AgendaDoProfessorQueryDto,
  ) {
    return this.agenda.resumoDoMes(
      user.companyId as string,
      user.sub,
      query.mes,
    );
  }

  @Get(':data')
  @ApiOkResponse({ type: [AulaDoDiaDoProfessorDto] })
  @Roles('professor')
  detalheDoDia(
    @CurrentUser() user: AccessTokenPayload,
    @Param() params: DataDaAgendaParamDto,
  ) {
    return this.agenda.detalheDoDia(
      user.companyId as string,
      user.sub,
      params.data,
    );
  }
}

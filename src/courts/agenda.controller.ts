import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AgendaService } from './agenda.service';
import { AgendaQueryDto } from './dto/agenda-query.dto';

/**
 * SPEC-012 — agenda do gestor. Só `company_admin`: o aluno tem a própria
 * visão em "Minhas Reservas" (SPEC-005).
 *
 * AC-009: o escopo por empresa é garantido **nos dois lugares** — o guard
 * autoriza a rota, e o `companyId` vem sempre do token, nunca de
 * parâmetro do cliente. Guard sozinho autoriza, não filtra dado.
 */
@ApiTags('agenda')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('agenda')
export class AgendaController {
  constructor(private readonly agenda: AgendaService) {}

  @Get()
  resumo(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: AgendaQueryDto,
  ) {
    const hoje = new Date();
    const mes =
      query.mes ??
      `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, '0')}`;
    return this.agenda.resumoDoMes(user.companyId as string, mes);
  }

  @Get(':data')
  dia(@CurrentUser() user: AccessTokenPayload, @Param('data') data: string) {
    return this.agenda.detalheDoDia(user.companyId as string, data);
  }
}

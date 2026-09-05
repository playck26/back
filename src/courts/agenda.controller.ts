import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AgendaService } from './agenda.service';
import {
  DiaComItensResponseDto,
  DiaDaAgendaResponseDto,
  ItemDaAgendaResponseDto,
} from './dto/booking-response.dto';
import { AgendaQueryDto, SemanaDaAgendaQueryDto } from './dto/agenda-query.dto';
import { DataDaAgendaParamDto } from './dto/data-do-calendario.dto';
import { mesCorrenteNoFusoDoClube } from './date-time.util';

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
  @ApiOkResponse({ type: [DiaDaAgendaResponseDto] })
  resumo(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: AgendaQueryDto,
  ) {
    // DEF-020: mês corrente no fuso do clube, não no relógio UTC do
    // servidor (DigitalOcean roda em UTC — herdar o fuso dele é herdar uma
    // decisão que ninguém tomou).
    const mes = query.mes ?? mesCorrenteNoFusoDoClube();
    return this.agenda.resumoDoMes(user.companyId as string, mes);
  }

  /**
   * SPEC-034/CON-034.1 — os sete dias, com o detalhe de cada um.
   *
   * **DECLARADA ANTES DE `@Get(':data')`, E ISSO É O MECANISMO (D9).** O Nest
   * casa as rotas na ordem de declaração: com `:data` antes, `semana` seria
   * lido como uma data, cairia no `DataDoCalendarioConstraint` e voltaria
   * `422` — uma rota inexistente que responde erro de validação. O AC-003
   * prova isto, e a sabotagem dele é justamente trocar as duas de lugar.
   */
  @Get('semana')
  @ApiOkResponse({ type: [DiaComItensResponseDto] })
  semana(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: SemanaDaAgendaQueryDto,
  ) {
    return this.agenda.semanaDe(user.companyId as string, query.inicio);
  }

  /**
   * DEF-020 — **a data passou a ser validada aqui também.**
   *
   * Era `@Param('data') data: string`, cru. `parseDateOnly('banana')` monta
   * um `Invalid Date`, o Prisma consulta com ele e a resposta volta
   * **vazia** — indistinguível de "não há reserva nesse dia". A SPEC-026
   * fechou esse buraco na rota do professor e deixou este aberto, o que é a
   * mesma assimetria que produziu o DEF-020 inteiro: corrigir onde se está
   * olhando e não onde o defeito mora.
   */
  @Get(':data')
  @ApiOkResponse({ type: [ItemDaAgendaResponseDto] })
  dia(
    @CurrentUser() user: AccessTokenPayload,
    @Param() params: DataDaAgendaParamDto,
  ) {
    return this.agenda.detalheDoDia(user.companyId as string, params.data);
  }
}

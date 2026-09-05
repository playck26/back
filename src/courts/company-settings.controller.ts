import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  ConfiguracaoDeHorariosResponseDto,
  ResultadoDeHorariosResponseDto,
} from './dto/horarios-response.dto';
import { DefinirHorariosDto } from './dto/definir-horarios.dto';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import {
  ConfigOperacaoResponseDto,
  DefinirConfigOperacaoDto,
} from '../company-settings/dto/config-operacao.dto';

/**
 * SPEC-010/REQ-001 — configurações da empresa.
 *
 * Fica em `courts` porque MOD-005 é o dono de `horarios_funcionamento`
 * (`TARGET_ARCHITECTURE.md`, seção de ownership): o horário existe para
 * definir a linha do tempo da quadra, e quem manda nela é MOD-005. A rota
 * é `/company-settings` por ser o que o admin procura — a organização
 * interna do código não precisa vazar para a URL.
 */
@ApiTags('company-settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('company-settings')
export class CompanySettingsController {
  constructor(
    private readonly horarios: HorarioFuncionamentoService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  @Get('horarios')
  // DEF-017 — era `HorariosDaQuadraResponseDto`, o DTO de OUTRA rota.
  @ApiOkResponse({ type: ConfiguracaoDeHorariosResponseDto })
  listar(@CurrentUser() user: AccessTokenPayload) {
    return this.horarios.listarConfiguracao(user.companyId as string);
  }

  @Put('horarios')
  @ApiOkResponse({ type: ResultadoDeHorariosResponseDto })
  definir(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: DefinirHorariosDto,
  ) {
    return this.horarios.definirPadraoDaEmpresa(user.companyId as string, dto);
  }

  /**
   * SPEC-031/AC-001 — os dois prazos de cancelamento.
   *
   * A classe inteira já é `CompanyAdminGuard`, entao quem escreve e o gestor.
   * **Empresa sem configuracao devolve os dois `null`, nao `404`** — nao ter
   * prazo e um estado normal, e e a maioria das empresas hoje.
   */
  @Get('operacao')
  @ApiOkResponse({ type: ConfigOperacaoResponseDto })
  lerOperacao(@CurrentUser() user: AccessTokenPayload) {
    return this.operacao.ler(user.companyId as string);
  }

  /**
   * SPEC-031/AC-002 — inteiro `>= 1` ou `null`. Zero, negativo e fracionario
   * saem em **400**, nao 422: `OPCOES_DE_VALIDACAO` nao define
   * `errorHttpStatusCode`, e `@Min` devolve 400 em todo o projeto. Pedir 422
   * aqui obrigaria um pipe por rota — a divergencia que `configurar-app.ts`
   * existe para impedir.
   */
  @Put('operacao')
  @ApiOkResponse({ type: ConfigOperacaoResponseDto })
  definirOperacao(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: DefinirConfigOperacaoDto,
  ) {
    return this.operacao.gravar(user.companyId as string, dto);
  }
}

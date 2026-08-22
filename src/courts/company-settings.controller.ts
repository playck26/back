import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { DefinirHorariosDto } from './dto/definir-horarios.dto';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';

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
  constructor(private readonly horarios: HorarioFuncionamentoService) {}

  @Get('horarios')
  listar(@CurrentUser() user: AccessTokenPayload) {
    return this.horarios.listarConfiguracao(user.companyId as string);
  }

  @Put('horarios')
  definir(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: DefinirHorariosDto,
  ) {
    return this.horarios.definirPadraoDaEmpresa(user.companyId as string, dto);
  }
}

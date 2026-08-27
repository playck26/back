import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  FrequenciaService,
  JANELA_MAXIMA_DIAS,
  JANELA_PADRAO_DIAS,
} from '../frequencia/frequencia.service';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { DashboardService } from './dashboard.service';
import { DashboardResumoResponseDto } from '../courts/dto/booking-response.dto';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly frequencias: FrequenciaService,
  ) {}

  /**
   * SPEC-015/TASK-003 e AC-008 — alunos em risco de evasão (INV-023).
   *
   * A régua é do **produto**, não da empresa (LIM-005): 3 ou mais
   * não-comparecimentos seguidos, ou frequência abaixo de 60% com base
   * mínima de 4 e cobertura acima do piso. Empresa sem ninguém em risco
   * devolve `{ total: 0, alunos: [] }` — o dashboard sempre desenha o
   * cartão, e um 404 aqui viraria erro na tela por ausência de problema.
   */
  @Get('evasao')
  evasao(
    @CurrentUser() user: AccessTokenPayload,
    @Query('dias', new DefaultValuePipe(JANELA_PADRAO_DIAS), ParseIntPipe)
    dias: number,
  ) {
    return this.frequencias.evasao(
      user.companyId as string,
      Math.min(Math.max(dias, 1), JANELA_MAXIMA_DIAS),
    );
  }

  @Get('summary')
  @ApiOkResponse({ type: DashboardResumoResponseDto })
  summary(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.summary(user.companyId as string, query);
  }
}

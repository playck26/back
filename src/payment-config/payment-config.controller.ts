import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { UpdatePaymentConfigDto } from './dto/update-payment-config.dto';
import {
  ConfiguracaoDePagamentoResponseDto,
  PagamentoPublicoResponseDto,
} from './dto/payment-config-response.dto';
import { PaymentConfigService } from './payment-config.service';

// CON-006.1 (configurar, company_admin) / CON-006.2 (consulta pública,
// aluno) — mesmo controller, roles diferentes por rota via RolesGuard.
@ApiTags('payment-config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payment-config')
export class PaymentConfigController {
  constructor(private readonly paymentConfigService: PaymentConfigService) {}

  @Get()
  @ApiOkResponse({ type: ConfiguracaoDePagamentoResponseDto })
  @Roles('company_admin')
  get(@CurrentUser() user: AccessTokenPayload) {
    return this.paymentConfigService.get(user.companyId as string);
  }

  @Put()
  @ApiOkResponse({ type: ConfiguracaoDePagamentoResponseDto })
  @Roles('company_admin')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: UpdatePaymentConfigDto,
  ) {
    return this.paymentConfigService.update(user.companyId as string, dto);
  }

  @Get('public')
  @ApiOkResponse({ type: PagamentoPublicoResponseDto })
  @Roles('aluno')
  getPublic(@CurrentUser() user: AccessTokenPayload) {
    return this.paymentConfigService.getPublic(user.companyId as string);
  }
}

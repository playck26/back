import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CourtsService } from '../courts/courts.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { OcupacaoResponseDto } from '../courts/dto/booking-response.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';

// CON-006.3 — rota vive sob /bookings (mesmo prefixo de MOD-005), mas
// pertence a MOD-006 (autorização e regra de negócio de pagamento):
// valida role=company_admin (INV-007, AC-001) e delega a escrita real
// para o método público de MOD-005 (CourtsService.updatePaymentStatus),
// dono exclusivo de `ocupacoes_quadra` (TARGET_ARCHITECTURE.md seção 5) —
// nunca acessa o repositório Prisma da tabela diretamente.
@ApiTags('bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bookings')
export class PaymentStatusController {
  constructor(private readonly courtsService: CourtsService) {}

  @Patch(':id/payment-status')
  @ApiOkResponse({ type: OcupacaoResponseDto })
  @Roles('company_admin')
  updateStatus(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
  ) {
    return this.courtsService.updatePaymentStatus(
      user.companyId as string,
      id,
      dto.status,
    );
  }
}

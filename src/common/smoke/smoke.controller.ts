import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { TenantGuard } from '../guards/tenant.guard';

/**
 * Rota de smoke dedicada só para provar o TenantGuard (AC-005, SPEC-001).
 * Nenhum recurso de domínio real existe ainda nesta spec — esta rota some
 * assim que a primeira rota de domínio real (spec 002+) puder assumir o
 * papel de prova.
 */
@ApiTags('smoke')
@ApiBearerAuth()
@Controller('_smoke')
@UseGuards(JwtAuthGuard, TenantGuard)
export class SmokeController {
  @Get('tenant-check/:companyId')
  tenantCheck(@Param('companyId') companyId: string) {
    return { ok: true, companyId };
  }
}

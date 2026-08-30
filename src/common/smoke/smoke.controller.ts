import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SmokeDeTenantResponseDto } from '../../companies/dto/empresa-publica-response.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { UuidCanonicoPipe } from '../pipes/uuid-canonico.pipe';
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
  @ApiOkResponse({ type: SmokeDeTenantResponseDto })
  /**
   * **Achado 3 da 4ª validação cruzada (BAIXA).** O `:companyId` era cru:
   * `not-a-uuid` devolvia `200 { ok: true, companyId: "not-a-uuid" }`
   * embora o DTO declare `format: uuid`, e um UUID em maiúsculas voltava sem
   * canonicalizar. Rota interna, então o risco de runtime era baixo — mas
   * **era uma violação da invariante que já existia enquanto o gate estava
   * verde**, e é isso que a torna importante: ela é a prova de que o gate
   * antigo não julgava o que dizia julgar.
   */
  tenantCheck(
    @Param('companyId', UuidCanonicoPipe) companyId: string,
  ): SmokeDeTenantResponseDto {
    return { ok: true, companyId };
  }
}

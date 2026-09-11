import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { AtualizarPlanoDto, CriarPlanoDto } from './dto/plano.dto';
import { PlanoResponseDto } from './dto/plano-response.dto';
import { PlanosService } from './planos.service';

/**
 * SPEC-037/REQ-001 — os planos, do gestor.
 *
 * **Nao ha `DELETE`, e a ausencia e a decisao** (AC-003/INV-115). Plano
 * contratado carrega historia, e apagar quebraria a FK `RESTRICT` com
 * `23503` -- que vaza como `500`. `PATCH { ativo: false }` e a unica forma, e
 * ela nunca perde dado.
 */
@ApiTags('planos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('planos')
export class PlanosController {
  constructor(private readonly planos: PlanosService) {}

  @Get()
  @ApiOkResponse({ type: PlanoResponseDto, isArray: true })
  listar(
    @CurrentUser() user: AccessTokenPayload,
    @Query('apenasAtivos') apenasAtivos?: string,
  ) {
    return this.planos.listar(
      user.companyId as string,
      apenasAtivos === 'true',
    );
  }

  @Post()
  @ApiOkResponse({ type: PlanoResponseDto })
  criar(@CurrentUser() user: AccessTokenPayload, @Body() dto: CriarPlanoDto) {
    return this.planos.criar(user.companyId as string, dto);
  }

  @Patch(':id')
  @ApiOkResponse({ type: PlanoResponseDto })
  atualizar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: AtualizarPlanoDto,
  ) {
    return this.planos.atualizar(user.companyId as string, id, dto);
  }
}

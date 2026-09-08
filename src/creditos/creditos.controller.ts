import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { CreditosAdminService } from './creditos-admin.service';
import {
  ExtratoDeCreditoResponseDto,
  MovimentoCriadoResponseDto,
} from './dto/creditos-response.dto';
import { LancarCreditoDto } from './dto/lancar-credito.dto';

/**
 * SPEC-033/TASK-004 — a carteira pela mão do admin.
 *
 * **`@Controller('students')` e não `creditos`**: o recurso é o aluno, e a
 * carteira é uma coleção dele. É o mesmo caminho de `students/:id/frequencia`
 * (SPEC-015), e manter a forma evita que o Admin precise de duas convenções
 * de URL para dois painéis do mesmo aluno.
 *
 * O `CompanyAdminGuard` é o que faz o aluno não alcançar estas rotas. Ele vê a
 * própria carteira por `GET /me/creditos` (TASK-006), **sem `motivo`**.
 */
@ApiTags('creditos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('students')
export class CreditosController {
  constructor(private readonly admin: CreditosAdminService) {}

  @Get(':id/creditos')
  @ApiOkResponse({ type: ExtratoDeCreditoResponseDto })
  extrato(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.admin.extrato(user.companyId as string, id);
  }

  /**
   * AC-001 — lançar ou retirar.
   *
   * **`201` e não `200`**: cria uma linha no ledger, e o ledger é
   * append-only (INV-070). Não há `PATCH` nem `DELETE` correspondentes de
   * propósito — o AC-005 diz que nada é editável nem apagável depois, e a
   * ausência das rotas é parte de como isso se sustenta.
   */
  @Post(':id/creditos')
  @ApiCreatedResponse({ type: MovimentoCriadoResponseDto })
  lancar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: LancarCreditoDto,
  ) {
    return this.admin.lancarOuRetirar(
      user.companyId as string,
      id,
      user.sub,
      dto,
    );
  }
}

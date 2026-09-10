import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { JanelaDeVencimentoDto } from './dto/janela-de-vencimento.dto';
import { VencimentosResponseDto } from './dto/vencimentos-response.dto';
import { MatriculasService } from './matriculas.service';

/**
 * SPEC-045/REQ-001 — **a única rota de matrícula por EMPRESA.**
 *
 * As três que existiam eram por aluno (`/students/:id/matriculas`,
 * `/me/matricula`), e era essa a forma do defeito: para saber quem vence, o
 * gestor abria a ficha de cada aluno. Medido em 2026-09-10 — dez fichas no
 * clube de demonstração, a lista inteira num clube real.
 *
 * **Controller próprio, e não um `@Get` a mais em `MatriculasController`:**
 * aquele é `@Controller('students/:alunoId/matriculas')`, e toda rota dele
 * carrega um `alunoId` na URL. Uma consulta da empresa inteira pendurada num
 * caminho que declara um aluno seria mentira de rota.
 *
 * **Não entra no `/dashboard`** (D6): aquela rota devolve três números
 * agregados e é lida a cada abertura do painel. Uma lista ali faria a resposta
 * crescer com o clube numa rota que existe para ser barata.
 */
@ApiTags('matriculas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('matriculas')
export class VencimentosController {
  constructor(private readonly matriculas: MatriculasService) {}

  @Get('vencimentos')
  @ApiOkResponse({ type: VencimentosResponseDto })
  vencimentos(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: JanelaDeVencimentoDto,
  ) {
    return this.matriculas.vencimentos(
      user.companyId as string,
      query.dias ?? 30,
    );
  }
}

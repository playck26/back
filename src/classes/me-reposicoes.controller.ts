import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { MarcarReposicaoDto } from './dto/marcar-reposicao.dto';
import {
  CreditoDeReposicaoResponseDto,
  OportunidadeDeReposicaoResponseDto,
  ReposicaoCriadaResponseDto,
} from './dto/reposicao-response.dto';
import { ReposicaoService } from './reposicao.service';

/**
 * SPEC-046 — **reposição de aula, pelo próprio aluno** (D3).
 *
 * ## Controller próprio, e não mais três rotas em `MeClassesController`
 *
 * Aquele é `@Controller('me/classes')`, e toda rota dele carrega uma turma na
 * URL. A reposição **atravessa turmas** de propósito: o aluno falta na A e
 * repõe na B. Pendurá-la num caminho que declara uma turma seria mentira de
 * rota — o mesmo motivo pelo qual a SPEC-045 criou `VencimentosController`.
 *
 * ## `@Roles('aluno')` em CADA método, e não só o prefixo `/me/`
 *
 * É a lição que a SPEC-031/D19 deixou escrita: *"o prefixo não é mecanismo"* —
 * o `RolesGuard` diz de si mesmo, em comentário, que deixa passar qualquer role
 * autenticada quando não há decorator. Sem ele, o gestor marcaria reposição em
 * nome de si mesmo e a LIM-046e viraria mentira.
 *
 * O `alunoId` nunca vem do corpo nem da URL: sai de `(companyId, user.sub)`.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/reposicoes')
export class MeReposicoesController {
  constructor(private readonly reposicoes: ReposicaoService) {}

  /**
   * REQ-001 — quantas reposições ele tem, e de quais faltas.
   *
   * **O crédito é derivado** (D1): não sai de coluna nenhuma, é
   * `faltas válidas − reposições`. Vem junto o teto do mês e quantas ele já
   * usou, porque *"você tem 1 crédito"* sem dizer que o teto acabou produz a
   * recusa que o aluno não entende.
   */
  @Get()
  @ApiOkResponse({ type: CreditoDeReposicaoResponseDto })
  @Roles('aluno')
  meuCredito(@CurrentUser() user: AccessTokenPayload) {
    return this.reposicoes.meuCredito(user.companyId as string, user.sub);
  }

  /**
   * REQ-002 — onde dá para repor.
   *
   * `vagas` já vem calculado (D2): a tela não tem como refazer a conta, porque
   * não conhece — e não deve conhecer — as faltas dos outros alunos.
   */
  @Get('oportunidades')
  @ApiOkResponse({ type: OportunidadeDeReposicaoResponseDto, isArray: true })
  @Roles('aluno')
  oportunidades(@CurrentUser() user: AccessTokenPayload) {
    return this.reposicoes.oportunidades(user.companyId as string, user.sub);
  }

  @Post()
  @ApiOkResponse({ type: ReposicaoCriadaResponseDto })
  @ApiConflictResponse({
    description:
      'Sem crédito (`SEM_CREDITO_DE_REPOSICAO`), falta já reposta (`FALTA_JA_REPOSTA`), aula cheia (`TURMA_SEM_VAGA`), teto do mês (`TETO_DE_REPOSICAO`), aula cancelada (`OCUPACAO_CANCELADA`) ou dentro do prazo (`PRAZO_DE_CANCELAMENTO`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Já matriculado na turma de destino (`JA_MATRICULADO_NA_TURMA`) ou turma fora de operação (`TURMA_INATIVA`).',
  })
  @Roles('aluno')
  marcar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: MarcarReposicaoDto,
  ) {
    return this.reposicoes.marcar(
      user.companyId as string,
      user.sub,
      dto.faltaId,
      dto.ocupacaoId,
    );
  }

  /**
   * AC-013/AC-014 — desmarcar, com o **mesmo prazo** da falta.
   *
   * *"Uma ação barrada com a inversa livre não é regra, é rodeio"*
   * (SPEC-031/D23). Sem o prazo, ele desmarcaria cinco minutos antes e a vaga
   * voltaria tarde demais para qualquer um usar.
   */
  @Delete(':id')
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description: 'Dentro do prazo de antecedência (`PRAZO_DE_CANCELAMENTO`).',
  })
  @HttpCode(204)
  @Roles('aluno')
  desmarcar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.reposicoes.desmarcar(user.companyId as string, user.sub, id);
  }
}

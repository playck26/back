import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { AulaDoAlunoResponseDto } from './dto/me-response.dto';
import {
  ErroDeMatriculaResponseDto,
  MatriculaDoAlunoResponseDto,
  TurmaDisponivelResponseDto,
} from './dto/matricula-do-aluno-response.dto';
import {
  AulasAnterioresPaginadasResponseDto,
  AvaliarAulaDto,
  ErroDeAvaliacaoResponseDto,
  MediaDaTurmaResponseDto,
  MinhaAvaliacaoResponseDto,
} from './dto/avaliacao-de-aula.dto';
import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { MatriculaDoAlunoService } from './matricula-do-aluno.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { ClassesService } from './classes.service';
import { FaltaAvisadaService } from './falta-avisada.service';

// CON-004.5 (SPEC-005) — exclusivo do aluno, separado do CRUD
// administrativo de turmas em ClassesController (company_admin).
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('me/classes')
export class MeClassesController {
  constructor(
    private readonly classesService: ClassesService,
    private readonly matricula: MatriculaDoAlunoService,
    private readonly avaliacoes: AvaliacaoDeAulaService,
    private readonly faltas: FaltaAvisadaService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [AulaDoAlunoResponseDto] })
  @Roles('aluno')
  myUpcomingClasses(@CurrentUser() user: AccessTokenPayload) {
    return this.classesService.myUpcomingClasses(
      user.companyId as string,
      user.sub,
    );
  }

  /**
   * SPEC-023/REQ-001 — as turmas do clube com a ocupação à vista.
   *
   * Declarada **antes** de qualquer `:id` neste controller: rota literal
   * depois de rota com parâmetro é o clássico "disponiveis" virando um id
   * inválido.
   */
  @Get('disponiveis')
  @ApiOkResponse({ type: [TurmaDisponivelResponseDto] })
  @Roles('aluno')
  disponiveis(@CurrentUser() user: AccessTokenPayload) {
    return this.matricula.disponiveis(user.companyId as string, user.sub);
  }

  /** SPEC-023/REQ-002 — entrar. Idempotente: entrar duas vezes é o mesmo estado. */
  @Post(':id')
  @ApiOkResponse({ type: MatriculaDoAlunoResponseDto })
  @ApiForbiddenResponse({ type: ErroDeMatriculaResponseDto })
  @ApiConflictResponse({ type: ErroDeMatriculaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente — ou de outra empresa. São 404 iguais de propósito (INV-023b): distinguir já entregaria informação sobre o outro clube.',
  })
  @HttpCode(200)
  @Roles('aluno')
  entrar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) turmaId: string,
  ) {
    return this.matricula.entrar(user.companyId as string, user.sub, turmaId);
  }

  /**
   * SPEC-025 — **as aulas que já aconteceram, para poder avaliá-las.**
   *
   * Declarada antes de qualquer `:id`: rota literal depois de rota com
   * parâmetro é o clássico "anteriores" virando um id inválido.
   *
   * `GET /me/classes` devolve só o futuro. Sem esta, não haveria como chegar
   * até a aula para dar nota.
   */
  @Get('anteriores')
  @ApiOkResponse({ type: AulasAnterioresPaginadasResponseDto })
  @Roles('aluno')
  aulasAnteriores(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.avaliacoes.aulasAnteriores(
      user.companyId as string,
      user.sub,
      query.page,
      query.pageSize,
    );
  }

  /**
   * SPEC-025 — a média da TURMA, agregada das notas das aulas dela.
   *
   * **Aluno e professor recebem esta**, e ela não tem autoria nem comentário
   * (INV-025a). O professor vê o mesmo número que o aluno: ele precisa saber
   * como está indo. O que ele não vê é quem disse o quê — a decisão do Israel
   * diz "somente o painel admin", e ela vale para autoria e comentário.
   */
  @Get(':id/avaliacao')
  @ApiOkResponse({ type: MediaDaTurmaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente ou de outra empresa — as duas respondem igual.',
  })
  @Roles('aluno', 'professor')
  mediaDaTurma(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) turmaId: string,
  ) {
    return this.avaliacoes.mediaDaTurma(user.companyId as string, turmaId);
  }

  /**
   * SPEC-025 — avalia ou corrige a nota de UMA AULA.
   *
   * `PUT` e não `POST`: o recurso é "a minha avaliação desta aula", e ele é
   * um só. Avaliar de novo é correção, garantida pela UNIQUE do banco.
   */
  @Put('aulas/:ocupacaoId/avaliacao')
  @ApiOkResponse({ type: MinhaAvaliacaoResponseDto })
  @ApiForbiddenResponse({ type: ErroDeAvaliacaoResponseDto })
  @ApiConflictResponse({ type: ErroDeAvaliacaoResponseDto })
  // Achado 3 da validação cruzada: o 404 acontecia em runtime e **não estava
  // publicado**. Contrato que esconde um caso é contrato errado, e cliente
  // gerado do OpenAPI não enxergava a recusa que a própria spec exige.
  //
  // Os três motivos devolvem o MESMO 404 de propósito: ocupação inexistente,
  // ocupação de outra empresa e reserva avulsa. Distinguir entregaria
  // informação sobre o outro clube (INV-023b).
  @ApiNotFoundResponse({
    description:
      'Aula inexistente, de outra empresa, ou ocupação avulsa (que não é aula de turma). Os três respondem igual de propósito.',
  })
  @Roles('aluno')
  avaliarAula(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
    @Body() dto: AvaliarAulaDto,
  ) {
    return this.avaliacoes.avaliar(
      user.companyId as string,
      user.sub,
      ocupacaoId,
      { nota: dto.nota, comentario: dto.comentario },
    );
  }

  /** SPEC-023/REQ-004 — sair, exceto quando a turma tem aula hoje. */
  @Delete(':id')
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErroDeMatriculaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente, de outra empresa, ou o aluno não está nela. Sair de onde não se está é engano, e silenciar esconderia bug de tela.',
  })
  @HttpCode(204)
  @Roles('aluno')
  sair(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) turmaId: string,
  ) {
    return this.matricula.sair(user.companyId as string, user.sub, turmaId);
  }

  /**
   * SPEC-031/AC-015 — **avisar que vai faltar, sem sair da turma.**
   *
   * `@Roles('aluno')` é obrigatório, e não decoração: o prefixo `/me/` **não
   * é mecanismo**. Sem o decorator, o `RolesGuard` diz de si mesmo, em
   * comentário, que deixa passar qualquer role autenticada.
   *
   * Idempotente pelo BANCO (AC-017): dois `POST` simultâneos produzem uma
   * linha, e o segundo devolve o mesmo `204`.
   */
  @Post(':turmaId/aulas/:ocupacaoId/falta')
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      'Ocorrência cancelada (`OCUPACAO_CANCELADA`) ou dentro do prazo de antecedência (`PRAZO_DE_CANCELAMENTO`).',
  })
  @ApiNotFoundResponse({
    description:
      'Aluno não matriculado na turma, ou a ocorrência não é desta turma. Os dois respondem igual: a URL da turma A não pode revelar a ocorrência da B.',
  })
  @HttpCode(204)
  avisarFalta(
    @CurrentUser() user: AccessTokenPayload,
    @Param('turmaId', UuidCanonicoPipe) turmaId: string,
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
  ) {
    return this.faltas.avisar(
      user.companyId as string,
      user.sub,
      turmaId,
      ocupacaoId,
    );
  }

  /**
   * SPEC-031/AC-016c (D23) — **retirar o aviso obedece à MESMA regra de
   * prazo.**
   *
   * Retirar significa "eu vou", que é o estado padrão, e parece inofensivo.
   * Mas com o `DELETE` livre o aluno avisaria cedo e retiraria em cima da
   * hora, terminando exatamente no estado que o prazo existe para negar:
   * falta sem aviso válido, tarde demais para o clube reagir.
   *
   * Repetir devolve o mesmo `204`, inclusive sem linha (AC-017b).
   */
  @Delete(':turmaId/aulas/:ocupacaoId/falta')
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      'Ocorrência cancelada (`OCUPACAO_CANCELADA`) ou dentro do prazo (`PRAZO_DE_CANCELAMENTO`) — simétrico ao `POST`, por decisão (D23).',
  })
  // O `404` acontecia em runtime e não estava publicado — o mesmo defeito que
  // as linhas 159-165 deste arquivo já registram: **contrato que esconde um
  // caso é contrato errado**. Os dois verbos compartilham
  // `comAOcorrenciaTravada`, que levanta `NotFoundException` nas duas mesmas
  // guardas; o `POST` declarava e o `DELETE` não, então o cliente gerado
  // tratava o `404` do `DELETE` como erro não previsto.
  @ApiNotFoundResponse({
    description:
      'Aluno não matriculado na turma, ou a ocorrência não é desta turma. Os dois respondem igual: a URL da turma A não pode revelar a ocorrência da B.',
  })
  @HttpCode(204)
  @Roles('aluno')
  retirarFalta(
    @CurrentUser() user: AccessTokenPayload,
    @Param('turmaId', UuidCanonicoPipe) turmaId: string,
    @Param('ocupacaoId', UuidCanonicoPipe) ocupacaoId: string,
  ) {
    return this.faltas.retirar(
      user.companyId as string,
      user.sub,
      turmaId,
      ocupacaoId,
    );
  }
}

import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Put,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  TurmaDetalheResponseDto,
  TurmaPaginadaResponseDto,
  TurmaResponseDto,
} from './dto/turma-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';
import { AvaliacoesDaTurmaResponseDto } from './dto/avaliacao-de-aula.dto';
import { ClassesService } from './classes.service';
import { PresencaService } from './presenca.service';
import {
  FrequenciaService,
  JANELA_MAXIMA_DIAS,
  JANELA_PADRAO_DIAS,
} from '../frequencia/frequencia.service';
import {
  MatriculaEmTurmaResponseDto,
  OcorrenciaNoHistoricoResponseDto,
} from './dto/presenca-historico-response.dto';
import { ChamadaNaoHouveResponseDto } from './dto/me-response.dto';
import { FrequenciaDaTurmaResponseDto } from '../frequencia/dto/frequencia-response.dto';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';

// Escopo desta spec (SPEC-003, fatia de turmas): UI só existe em `admin`
// (TASK-006) — guard restrito a company_admin. CON-004.1 documenta
// leitura por `aluno` também; estendido quando SPEC-005 (app do aluno)
// precisar (CON-004.5-7, fora do escopo desta spec).
@ApiTags('classes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('classes')
export class ClassesController {
  constructor(
    private readonly classesService: ClassesService,
    private readonly presencas: PresencaService,
    private readonly frequencias: FrequenciaService,
    private readonly avaliacoes: AvaliacaoDeAulaService,
  ) {}

  /**
   * SPEC-014/AC-009 — histórico de presença da turma, **só leitura**
   * (LIM-002). Fica no controller do gestor, e não no de `me/teacher`,
   * porque o escopo aqui é a empresa inteira: o gestor vê qualquer turma
   * dela, o professor só as próprias.
   */
  /**
   * SPEC-015/AC-001..AC-006 — relatório de frequência da turma.
   *
   * Mesmo guard do resto deste controller (`CompanyAdminGuard`), que é o
   * que faz AC-010 valer: `aluno`, `professor` e `super_admin` levam 403.
   * O professor **não** vê frequência nesta spec (LIM-004) — ele lança a
   * chamada, quem lê o agregado é o gestor.
   */
  /**
   * SPEC-025/REQ-005 — **a lista completa, e ela só existe aqui.**
   *
   * Nome e comentário saem por esta rota e por nenhuma outra. A decisão do
   * Israel (ADR-017, item 4) é que "somente o painel admin vê quem avaliou e
   * os comentários" — e o que separa esta resposta da que o aluno recebe não
   * é um filtro no meio do caminho: são **dois DTOs diferentes**, para que
   * acrescentar um campo do lado errado seja uma decisão visível em vez de um
   * vazamento silencioso (INV-025a).
   */
  @Get(':id/avaliacoes')
  @ApiOkResponse({ type: AvaliacoesDaTurmaResponseDto })
  @ApiNotFoundResponse({
    description:
      'Turma inexistente ou de outra empresa — as duas respondem igual.',
  })
  avaliacoesDaTurma(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.avaliacoes.listarParaOGestor(user.companyId as string, id);
  }

  @Get(':id/frequencia')
  @ApiOkResponse({ type: FrequenciaDaTurmaResponseDto })
  frequencia(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('dias', new DefaultValuePipe(JANELA_PADRAO_DIAS), ParseIntPipe)
    dias: number,
  ) {
    return this.frequencias.daTurma(
      user.companyId as string,
      id,
      Math.min(Math.max(dias, 1), JANELA_MAXIMA_DIAS),
    );
  }

  @Get(':id/presencas')
  @ApiOkResponse({ type: [OcorrenciaNoHistoricoResponseDto] })
  historicoDePresenca(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('dias', new DefaultValuePipe(30), ParseIntPipe) dias: number,
  ) {
    return this.presencas.historicoDaTurma(
      user.companyId as string,
      id,
      Math.min(Math.max(dias, 1), 90),
    );
  }

  /**
   * SPEC-030 — **o gestor registra que a aula não aconteceu.**
   *
   * Decisão do Israel (D1): registram os dois. O motivo é o caso que o
   * professor não resolve — **professor sai do clube**, e a aula que ele não
   * registrou ficaria pendente para sempre, sem ninguém com caminho para
   * fechá-la.
   *
   * Aninhada sob a turma porque é a tela que ele já abre: o histórico logo
   * acima (`GET :id/presencas`) é onde a aula pendente aparece para ele.
   *
   * **Mesmo serviço da rota do professor**, com o escopo de professor
   * ausente — para o gestor não há "colega", e o que o separa de outra
   * empresa é o `company_id`, que está no `WHERE` das duas queries do
   * portão. Ausência de escopo de professor não é ausência de escopo.
   *
   * `:turmaId` não é usado na busca (o `ocupacaoId` já é único e escopado
   * por empresa), e continua na rota porque é o recurso ao qual a ação
   * pertence — quem lê a URL entende o que está sendo alterado.
   */
  // Sem `@Roles`: este controller inteiro é protegido por `CompanyAdminGuard`
  // (topo da classe), não por `RolesGuard`. Um `@Roles` aqui seria decoração
  // morta — parece que restringe e não é lido por ninguém, que é pior do que
  // não ter.
  @Put(':turmaId/presencas/:ocupacaoId/nao-houve')
  @ApiOkResponse({ type: ChamadaNaoHouveResponseDto })
  naoHouve(
    @CurrentUser() user: AccessTokenPayload,
    @Param('turmaId', ParseUUIDPipe) _turmaId: string,
    @Param('ocupacaoId', ParseUUIDPipe) ocupacaoId: string,
  ) {
    return this.presencas.registrarNaoHouve(
      user.companyId as string,
      ocupacaoId,
      user.sub,
      // `false` = sem escopo de professor. A empresa continua valendo.
      false,
    );
  }

  @Get()
  @ApiOkResponse({ type: TurmaPaginadaResponseDto })
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.classesService.list(user.companyId as string, query);
  }

  @Post()
  @ApiOkResponse({ type: TurmaResponseDto })
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateClassDto) {
    return this.classesService.create(user.companyId as string, dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: TurmaDetalheResponseDto })
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.classesService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: TurmaDetalheResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassDto,
  ) {
    return this.classesService.update(user.companyId as string, id, dto);
  }

  @Post(':id/students/:alunoId')
  @ApiCreatedResponse({ type: MatriculaEmTurmaResponseDto })
  allocateStudent(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alunoId', ParseUUIDPipe) alunoId: string,
  ) {
    return this.classesService.allocateStudent(
      user.companyId as string,
      id,
      alunoId,
    );
  }

  @Delete(':id/students/:alunoId')
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  removeStudent(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alunoId', ParseUUIDPipe) alunoId: string,
  ) {
    return this.classesService.removeStudent(
      user.companyId as string,
      id,
      alunoId,
    );
  }
}

import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AcessoService } from '../acesso/acesso.service';
import { SituacaoDoConviteResponseDto } from '../acesso/dto/situacao-do-convite.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  AlunoComSenhaTemporariaResponseDto,
  AlunoPaginadoResponseDto,
  AlunoResponseDto,
} from './dto/people-response.dto';
import { FrequenciaDoAlunoResponseDto } from '../frequencia/dto/frequencia-response.dto';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentsService } from './students.service';
import { ExportacaoDeAlunosService } from './importacao/exportacao-de-alunos.service';
import {
  FrequenciaService,
  JANELA_MAXIMA_DIAS,
  JANELA_PADRAO_DIAS,
} from '../frequencia/frequencia.service';

@ApiTags('students')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('students')
export class StudentsController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly frequencias: FrequenciaService,
    /** SPEC-083 — por último, pela lição da SPEC-039 (ver `InvitesService`). */
    private readonly acesso: AcessoService,
    /** SPEC-092 — por último, pela mesma lição. */
    private readonly exportacao: ExportacaoDeAlunosService,
  ) {}

  /**
   * SPEC-015/AC-007 — relatório de frequência do aluno: agregado, quebra
   * por turma e as últimas ocorrências.
   *
   * Mesmo guard do resto do controller (`CompanyAdminGuard`), que é o que
   * faz a AC-010 valer. **O aluno não vê a própria frequência nesta spec**
   * — é decisão de produto com efeito na relação dele com o professor, e
   * está fora de escopo de propósito.
   */
  @Get(':id/frequencia')
  @ApiOkResponse({ type: FrequenciaDoAlunoResponseDto })
  frequencia(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Query('dias', new DefaultValuePipe(JANELA_PADRAO_DIAS), ParseIntPipe)
    dias: number,
  ) {
    return this.frequencias.doAluno(
      user.companyId as string,
      id,
      Math.min(Math.max(dias, 1), JANELA_MAXIMA_DIAS),
    );
  }

  // `?vinculo=pendente` é a fila de aprovação do admin (SPEC-009/AC-015).
  @Get()
  @ApiOkResponse({ type: AlunoPaginadoResponseDto })
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: ListStudentsQueryDto,
  ) {
    return this.studentsService.list(user.companyId as string, query);
  }

  /**
   * SPEC-092 — a planilha de TODOS os alunos do clube, no formato do modelo
   * da importação (D1, D2), com a coluna `Status` (D3).
   *
   * **Declarada antes de `@Get(':id')`, e não por gosto:** o Express casa na
   * ordem de registro, e depois do `:id` a palavra `exportar` chegaria ao
   * `UuidCanonicoPipe` como id e responderia 400 (DEF-039, o gate da
   * SPEC-067 confere).
   *
   * O clube sai do token, e só dele (D6): a rota não lê parâmetro nenhum.
   * `no-store` porque o arquivo tem e-mail e telefone de gente, e não há
   * motivo para um proxy ou o disco do navegador guardarem uma cópia.
   *
   * O `Access-Control-Expose-Headers` vai **nesta resposta**, e não nas
   * opções de CORS (cujo conjunto é fechado e tem prova própria): sem ele, o
   * Admin, que mora em outra origem, não consegue ler o nome do arquivo.
   */
  @Get('exportar')
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description:
      'CSV com BOM, `;` e CRLF: Nome;E-mail;Telefone;Nível;Turma 1…N;Status. O nome do arquivo vem em Content-Disposition (alunos-AAAA-MM-DD.csv).',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  async exportar(
    @CurrentUser() user: AccessTokenPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { nomeDoArquivo, conteudo } = await this.exportacao.exportar(
      user.companyId as string,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nomeDoArquivo}"`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'no-store');
    return conteudo;
  }

  // SPEC-009/REQ-008: decidir sobre um cadastro é ação exclusiva do
  // `company_admin` da própria empresa — a autorização já vem dos guards
  // deste controller (AC-016).
  // SPEC-009/REQ-005: substituto oficial do "esqueci minha senha" enquanto
  // não houver e-mail transacional (GAP-004, ADR-013).
  @Post(':id/senha-temporaria')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AlunoComSenhaTemporariaResponseDto })
  regenerarSenhaTemporaria(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.studentsService.regenerarSenhaTemporaria(
      user.companyId as string,
      id,
    );
  }

  /**
   * SPEC-083/D9 — a situação do convite por e-mail, para o cartão da ficha.
   * Rota própria, e não campo do `AlunoResponseDto`: aquele é o das listas, e
   * a situação custaria uma leitura por linha.
   */
  @Get(':id/convite-de-acesso')
  @ApiOkResponse({ type: SituacaoDoConviteResponseDto })
  situacaoDoConvite(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.acesso.situacaoDoAluno(user.companyId as string, id);
  }

  /**
   * SPEC-083/D9 — enviar e reenviar são o mesmo gesto: revoga o convite vivo,
   * emite outro e manda o e-mail depois do commit. Responde a situação já com
   * o resultado do envio; **e-mail recusado não é erro da rota** (AC-026), é
   * `falhou` com o motivo. Conta com senha própria é `409 CONTA_JA_ATIVADA`.
   */
  @Post(':id/convite-de-acesso')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SituacaoDoConviteResponseDto })
  enviarConvite(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.acesso.enviarParaAluno(user.companyId as string, id, user.sub);
  }

  @Post(':id/aprovar')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AlunoResponseDto })
  aprovar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.studentsService.decidirVinculo(
      user.companyId as string,
      id,
      'aprovado',
    );
  }

  @Post(':id/recusar')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AlunoResponseDto })
  recusar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.studentsService.decidirVinculo(
      user.companyId as string,
      id,
      'recusado',
    );
  }

  @Post()
  @ApiCreatedResponse({ type: AlunoComSenhaTemporariaResponseDto })
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateStudentDto,
  ) {
    return this.studentsService.create(user.companyId as string, dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: AlunoResponseDto })
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.studentsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AlunoResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(user.companyId as string, id, dto);
  }
}

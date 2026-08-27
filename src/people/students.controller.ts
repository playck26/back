import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
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
import { CreateStudentDto } from './dto/create-student.dto';
import { ListStudentsQueryDto } from './dto/list-students-query.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentsService } from './students.service';
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
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.regenerarSenhaTemporaria(
      user.companyId as string,
      id,
    );
  }

  @Post(':id/aprovar')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AlunoResponseDto })
  aprovar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
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
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.studentsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AlunoResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(user.companyId as string, id, dto);
  }
}

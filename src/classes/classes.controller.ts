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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { ClassesService } from './classes.service';
import { PresencaService } from './presenca.service';
import {
  FrequenciaService,
  JANELA_MAXIMA_DIAS,
  JANELA_PADRAO_DIAS,
} from './frequencia.service';
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
  @Get(':id/frequencia')
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

  @Get()
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.classesService.list(user.companyId as string, query);
  }

  @Post()
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateClassDto) {
    return this.classesService.create(user.companyId as string, dto);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.classesService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClassDto,
  ) {
    return this.classesService.update(user.companyId as string, id, dto);
  }

  @Post(':id/students/:alunoId')
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

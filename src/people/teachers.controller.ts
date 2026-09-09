import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
  ProfessorComSenhaTemporariaResponseDto,
  ProfessorPaginadoResponseDto,
  ProfessorResponseDto,
} from './dto/people-response.dto';
import { UuidCanonicoPipe } from '../common/pipes/uuid-canonico.pipe';
import { CreateTeacherDto } from './dto/create-teacher.dto';
import { DefinirDisponibilidadeDto } from './dto/definir-disponibilidade.dto';
import { DiaDisponibilidadeResponseDto } from './dto/disponibilidade-response.dto';
import { DisponibilidadeProfessorService } from './disponibilidade-professor.service';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateTeacherDto } from './dto/update-teacher.dto';
import { TeachersService } from './teachers.service';

@ApiTags('teachers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('teachers')
export class TeachersController {
  constructor(
    private readonly teachersService: TeachersService,
    private readonly disponibilidade: DisponibilidadeProfessorService,
  ) {}

  @Get()
  @ApiOkResponse({ type: ProfessorPaginadoResponseDto })
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.teachersService.list(user.companyId as string, query);
  }

  @Post()
  @ApiCreatedResponse({ type: ProfessorResponseDto })
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateTeacherDto,
  ) {
    return this.teachersService.create(user.companyId as string, dto);
  }

  /**
   * SPEC-013 — cria (ou rotaciona) o acesso do professor. `POST` e nao
   * `PATCH` porque o efeito e gerar uma credencial nova, nao editar um
   * campo: chamar duas vezes tem consequencia real (a senha anterior para
   * de valer), e o verbo precisa avisar isso.
   */
  @Post(':id/acesso')
  @ApiCreatedResponse({ type: ProfessorComSenhaTemporariaResponseDto })
  gerarAcesso(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.teachersService.gerarAcesso(user.companyId as string, id);
  }

  /**
   * SPEC-040/REQ-001 — a semana em que o professor atende.
   *
   * `PUT` porque substitui a grade inteira (AC-001). Vem ANTES de `@Get(':id')`
   * e `@Patch(':id')` no arquivo por convencao do modulo, mas o Nest casa por
   * caminho e nao por ordem quando os segmentos diferem — `:id/disponibilidade`
   * nunca colide com `:id`.
   */
  @Put(':id/disponibilidade')
  @ApiOkResponse({ type: [DiaDisponibilidadeResponseDto] })
  definirDisponibilidade(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: DefinirDisponibilidadeDto,
  ) {
    return this.disponibilidade.definir(user.companyId as string, id, dto);
  }

  /** SPEC-040/REQ-002/AC-007 — os sete dias, sempre. */
  @Get(':id/disponibilidade')
  @ApiOkResponse({ type: [DiaDisponibilidadeResponseDto] })
  lerDisponibilidade(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.disponibilidade.listar(user.companyId as string, id);
  }

  @Get(':id')
  @ApiOkResponse({ type: ProfessorResponseDto })
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.teachersService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: ProfessorResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: UpdateTeacherDto,
  ) {
    return this.teachersService.update(user.companyId as string, id, dto);
  }
}

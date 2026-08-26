import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import { CourtsService } from './courts.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { DefinirHorariosDto } from './dto/definir-horarios.dto';
import { CreateCourtDto } from './dto/create-court.dto';
import { UpdateCourtDto } from './dto/update-court.dto';
import {
  QuadraPaginadaResponseDto,
  QuadraResponseDto,
} from './dto/quadra-response.dto';

// CON-005.1/005.3: leitura (list/findOne/availability) é aberta a
// `company_admin` e `aluno` (SPEC-005, app do aluno navega a mesma
// grade) — escrita (create/update) continua exclusiva de `company_admin`.
@ApiTags('courts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('courts')
export class CourtsController {
  constructor(
    private readonly courtsService: CourtsService,
    private readonly horariosService: HorarioFuncionamentoService,
  ) {}

  @Get()
  @Roles('company_admin', 'aluno')
  @ApiOkResponse({ type: QuadraPaginadaResponseDto })
  list(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.courtsService.list(
      user.companyId as string,
      query.page,
      query.pageSize,
    );
  }

  @Post()
  @Roles('company_admin')
  @ApiOkResponse({ type: QuadraResponseDto })
  create(@CurrentUser() user: AccessTokenPayload, @Body() dto: CreateCourtDto) {
    return this.courtsService.create(user.companyId as string, dto);
  }

  @Get(':id')
  @Roles('company_admin', 'aluno')
  @ApiOkResponse({ type: QuadraResponseDto })
  findOne(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.courtsService.findOne(user.companyId as string, id);
  }

  @Patch(':id')
  @Roles('company_admin')
  @ApiOkResponse({ type: QuadraResponseDto })
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourtDto,
  ) {
    return this.courtsService.update(user.companyId as string, id, dto);
  }

  @Get(':id/availability')
  @Roles('company_admin', 'aluno')
  availability(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.courtsService.availability(
      user.companyId as string,
      id,
      query.data,
    );
  }

  // SPEC-010/REQ-002 — horário próprio da quadra. Escrita é exclusiva de
  // `company_admin`; a leitura entra junto porque a tela de configuração
  // precisa mostrar o que está valendo hoje.
  @Get(':id/horarios')
  @Roles('company_admin')
  horarios(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.horariosService.listarDaQuadra(user.companyId as string, id);
  }

  @Put(':id/horarios')
  @Roles('company_admin')
  definirHorarios(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DefinirHorariosDto,
  ) {
    return this.horariosService.definirDaQuadra(
      user.companyId as string,
      id,
      dto,
    );
  }

  // AC-004: some o horário próprio e a quadra **volta a herdar** o padrão.
  @Delete(':id/horarios')
  @Roles('company_admin')
  removerHorarios(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.horariosService.removerDaQuadra(user.companyId as string, id);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CompaniesService } from './companies.service';
import {
  AdminDaEmpresaResponseDto,
  EmpresaCriadaResponseDto,
  EmpresaPaginadaResponseDto,
  EmpresaResponseDto,
  SenhaDeAdminResponseDto,
} from './dto/company-response.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';

@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  @ApiOkResponse({ type: EmpresaPaginadaResponseDto })
  list(@Query() query: ListCompaniesQueryDto) {
    return this.companiesService.list(query);
  }

  @Post()
  @ApiCreatedResponse({ type: EmpresaCriadaResponseDto })
  create(@Body() dto: CreateCompanyDto) {
    return this.companiesService.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: EmpresaResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.companiesService.findOne(id);
  }

  /** SPEC-016/AC-001 — os gestores da empresa. */
  @Get(':id/admins')
  @ApiOkResponse({ type: [AdminDaEmpresaResponseDto] })
  listAdmins(@Param('id', ParseUUIDPipe) id: string) {
    return this.companiesService.listAdmins(id);
  }

  /**
   * SPEC-016/AC-002 — devolve o acesso de um gestor.
   *
   * `POST` e não `PATCH` pela mesma razão do `POST /teachers/:id/acesso`: o
   * efeito é gerar credencial nova, não editar campo. Chamar duas vezes tem
   * consequência real — a senha anterior para de valer (AC-008) —, e o
   * verbo precisa avisar isso.
   */
  @Post(':id/admins/:usuarioId/senha-temporaria')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SenhaDeAdminResponseDto })
  gerarSenhaDeAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.companiesService.gerarSenhaTemporariaDeAdmin(id, usuarioId);
  }

  @Patch(':id')
  @ApiOkResponse({ type: EmpresaResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOkResponse({ type: EmpresaResponseDto })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyStatusDto,
  ) {
    return this.companiesService.updateStatus(id, dto);
  }
}

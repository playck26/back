import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { AdicionaisService } from './adicionais.service';
import {
  AdicionaisDisponiveisQueryDto,
  AdicionalDisponivelResponseDto,
  AdicionalEditadoResponseDto,
  AdicionalResponseDto,
  CriarAdicionalDto,
  CriarTipoDeAdicionalDto,
  EditarAdicionalDto,
  EditarTipoDeAdicionalDto,
  TipoDeAdicionalResponseDto,
} from './dto/adicionais.dto';
import { TiposDeAdicionalService } from './tipos-de-adicional.service';

/**
 * SPEC-054/D8 — os tipos de adicional.
 *
 * **`RolesGuard`, como os catálogos de quadra da SPEC-020**: a leitura é também
 * do `aluno` (a tela de reserva agrupa por tipo), a escrita é só do gestor.
 * `super_admin` fica de fora por não ter empresa.
 */
@ApiTags('tipos-de-adicional')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tipos-de-adicional')
export class TiposDeAdicionalController {
  constructor(private readonly tipos: TiposDeAdicionalService) {}

  @Get()
  @Roles('company_admin', 'aluno')
  @ApiOkResponse({ type: [TipoDeAdicionalResponseDto] })
  listar(@CurrentUser() user: AccessTokenPayload) {
    return this.tipos.listar(user.companyId as string);
  }

  @Post()
  @Roles('company_admin')
  @ApiOkResponse({ type: TipoDeAdicionalResponseDto })
  @ApiConflictResponse({ description: '`TIPO_JA_EXISTE`' })
  @ApiBadRequestResponse({ description: 'validação, ou `VALOR_INVALIDO`' })
  criar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CriarTipoDeAdicionalDto,
  ) {
    return this.tipos.criar(user.companyId as string, dto);
  }

  @Patch(':id')
  @Roles('company_admin')
  @ApiOkResponse({ type: TipoDeAdicionalResponseDto })
  @ApiNotFoundResponse({ description: '`TIPO_NAO_ENCONTRADO`' })
  @ApiConflictResponse({ description: '`TIPO_JA_EXISTE`' })
  @ApiBadRequestResponse({ description: 'validação, ou `VALOR_INVALIDO`' })
  renomear(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: EditarTipoDeAdicionalDto,
  ) {
    return this.tipos.renomear(user.companyId as string, id, dto);
  }

  @Delete(':id')
  @Roles('company_admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: '`TIPO_NAO_ENCONTRADO`' })
  @ApiUnprocessableEntityResponse({
    description: '`TIPO_EM_USO`, com `adicionais`: a contagem',
  })
  apagar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
  ) {
    return this.tipos.apagar(user.companyId as string, id);
  }
}

/**
 * SPEC-054/D8 — os adicionais. **Sem `DELETE`**: tirar de oferta é
 * `ativo: false`, porque o item de reserva aponta para cá e guarda o que foi
 * cobrado.
 *
 * `disponiveis` é declarada ANTES das rotas com `:id` — a ordem das rotas no
 * Nest é a ordem de declaração.
 */
@ApiTags('adicionais')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('adicionais')
export class AdicionaisController {
  constructor(private readonly adicionais: AdicionaisService) {}

  @Get('disponiveis')
  @Roles('company_admin', 'aluno')
  @ApiOkResponse({ type: [AdicionalDisponivelResponseDto] })
  disponiveis(
    @CurrentUser() user: AccessTokenPayload,
    @Query() query: AdicionaisDisponiveisQueryDto,
  ) {
    return this.adicionais.disponiveis(
      user.companyId as string,
      query.data,
      query.slots,
    );
  }

  @Get()
  @Roles('company_admin')
  @ApiOkResponse({ type: [AdicionalResponseDto] })
  listar(@CurrentUser() user: AccessTokenPayload) {
    return this.adicionais.listar(user.companyId as string);
  }

  @Post()
  @Roles('company_admin')
  @ApiOkResponse({ type: AdicionalResponseDto })
  @ApiNotFoundResponse({ description: '`TIPO_NAO_ENCONTRADO`' })
  @ApiConflictResponse({ description: '`ADICIONAL_JA_EXISTE`' })
  @ApiBadRequestResponse({ description: 'validação, ou `VALOR_INVALIDO`' })
  criar(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CriarAdicionalDto,
  ) {
    return this.adicionais.criar(user.companyId as string, dto);
  }

  @Patch(':id')
  @Roles('company_admin')
  @ApiOkResponse({ type: AdicionalEditadoResponseDto })
  @ApiNotFoundResponse({
    description: '`ADICIONAL_NAO_ENCONTRADO` ou `TIPO_NAO_ENCONTRADO`',
  })
  @ApiConflictResponse({ description: '`ADICIONAL_JA_EXISTE`' })
  @ApiBadRequestResponse({ description: 'validação, ou `VALOR_INVALIDO`' })
  editar(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidCanonicoPipe) id: string,
    @Body() dto: EditarAdicionalDto,
  ) {
    return this.adicionais.editar(user.companyId as string, id, dto);
  }
}

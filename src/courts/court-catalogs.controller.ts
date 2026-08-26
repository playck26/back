import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import type { CatalogoDeQuadraService } from './catalogo-de-quadra.service';
import {
  CategoriasDeQuadraService,
  EsportesDeQuadraService,
} from './catalogos-de-quadra';
import { CatalogoDeQuadraDto } from './dto/catalogo-de-quadra.dto';

/**
 * SPEC-020/TASK-002 — as rotas dos dois catálogos.
 *
 * **`RolesGuard`, e não `CompanyAdminGuard` como em `levels`.** A diferença é
 * a leitura: o contrato desta spec dá o `GET` também a `aluno` e `professor`,
 * e o `CompanyAdminGuard` fecharia a rota inteira para eles.
 *
 * **A escrita continua sendo só do gestor.** `super_admin` fica de fora dos
 * dois lados por não ter empresa — o catálogo é de um clube, e ele não tem um
 * (mesma razão da imagem de quadra, LIM-005 da SPEC-018).
 *
 * **Nota para a TASK-006:** se o filtro do app do aluno for derivado das
 * quadras que já vieram — que é o que a INV-056 corrigida permite —, o `GET`
 * por `aluno` pode acabar sem consumidor. Está aqui porque é o contrato
 * escrito; se a TASK-006 não usar, é lá que a decisão de removê-lo se toma,
 * com o motivo escrito.
 */
abstract class CatalogoController {
  protected abstract get servico(): CatalogoDeQuadraService;

  @Get()
  @Roles('company_admin', 'aluno', 'professor')
  list(@CurrentUser() user: AccessTokenPayload) {
    return this.servico.list(user.companyId as string);
  }

  @Post()
  @Roles('company_admin')
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CatalogoDeQuadraDto,
  ) {
    return this.servico.create(user.companyId as string, dto);
  }

  @Patch(':id')
  @Roles('company_admin')
  update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CatalogoDeQuadraDto,
  ) {
    return this.servico.update(user.companyId as string, id, dto);
  }

  @Delete(':id')
  @Roles('company_admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servico.remove(user.companyId as string, id);
  }
}

@ApiTags('court-sports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('court-sports')
export class CourtSportsController extends CatalogoController {
  constructor(private readonly esportes: EsportesDeQuadraService) {
    super();
  }

  protected get servico(): CatalogoDeQuadraService {
    return this.esportes;
  }
}

@ApiTags('court-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('court-categories')
export class CourtCategoriesController extends CatalogoController {
  constructor(private readonly categorias: CategoriasDeQuadraService) {
    super();
  }

  protected get servico(): CatalogoDeQuadraService {
    return this.categorias;
  }
}

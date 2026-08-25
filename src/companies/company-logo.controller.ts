import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Put,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  CAMPO_DO_ARQUIVO,
  exigirArquivo,
  UploadDeMidia,
} from '../storage/upload-de-midia';
import { LogoDaEmpresaService } from './logo-da-empresa.service';

/**
 * SPEC-018/TASK-006 — upload da logo.
 *
 * **Aqui existe `:id` na URL, e por isso o escopo é conferido de verdade.**
 * Na TASK-003 a segurança vinha da forma da rota (`/me/foto` não aceita id
 * de ninguém); aqui não há essa saída — a logo é de uma empresa que o
 * `super_admin` também pode tocar. O `RolesGuard` decide *quem pode existir
 * nesta rota*; o serviço decide *qual empresa cada um alcança*, e recusa com
 * **404, nunca 403** (AC-014).
 *
 * `ParseUUIDPipe` na frente: id malformado é 400 antes de qualquer consulta,
 * e o parser da chave nunca recebe algo que não seja UUID.
 */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('companies/:id/logo')
export class CompanyLogoController {
  constructor(private readonly logos: LogoDaEmpresaService) {}

  @Put()
  @Roles('company_admin', 'super_admin')
  @UploadDeMidia()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        [CAMPO_DO_ARQUIVO]: { type: 'string', format: 'binary' },
      },
    },
  })
  substituir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    return this.logos.substituir(id, user, exigirArquivo(arquivo));
  }

  /**
   * Devolve a logo resolvida em vez de 204: quem removeu quer saber **o que
   * a tela vai mostrar agora**, e a resposta pode não ser "nada" — se a
   * empresa tinha `logo_url` externa, ela volta a valer (AC-013).
   */
  @Delete()
  @Roles('company_admin', 'super_admin')
  remover(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.logos.remover(id, user);
  }
}

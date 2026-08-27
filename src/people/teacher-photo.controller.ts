import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Put,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FotoDeProfessorResponseDto } from '../storage/dto/midia-response.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  CAMPO_DO_ARQUIVO,
  exigirArquivo,
  UploadDeMidia,
} from '../storage/upload-de-midia';
import { FotoDeProfessorService } from './foto-de-professor.service';

/**
 * SPEC-018/TASK-004 — upload da foto do professor, pela ficha.
 *
 * **`company_admin` e só ele.** A tabela de atores da spec dá ao gestor
 * "imagem de quadra, logo, e foto de professor sem conta"; `super_admin`
 * fica de fora pelo mesmo motivo estrutural das outras rotas de mídia — não
 * tem empresa, e a chave começa por `empresas/<company_id>/` (LIM-005).
 *
 * **Há `:id` na URL, então o escopo é decisão de código**, não da forma da
 * rota: o serviço confere a empresa do token e recusa com **404, nunca 403**
 * (AC-014). Aqui isso pesa mais do que na logo — o objeto é a foto de uma
 * pessoa, e um 403 confirmaria que ela trabalha naquele clube.
 *
 * `ParseUUIDPipe` na frente: id malformado é 400 antes de qualquer consulta.
 */
@ApiTags('teachers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('teachers/:id/foto')
export class TeacherPhotoController {
  constructor(private readonly fotos: FotoDeProfessorService) {}

  @Put()
  @ApiOkResponse({ type: FotoDeProfessorResponseDto })
  @Roles('company_admin')
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
    return this.fotos.substituir(id, user, exigirArquivo(arquivo));
  }

  /**
   * Devolve a foto **resolvida** em vez de 204, e aqui isso não é detalhe: se
   * o professor tiver conta e foto própria, remover a da ficha **não deixa a
   * tela vazia** — a dele passa a aparecer (INV-034). Quem removeu precisa
   * saber o que a tela vai mostrar agora.
   */
  @Delete()
  @ApiOkResponse({ type: FotoDeProfessorResponseDto })
  @Roles('company_admin')
  remover(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.fotos.remover(id, user);
  }
}

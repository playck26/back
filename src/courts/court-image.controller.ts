import {
  Body,
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
import { ImagemDaQuadraService } from './imagem-da-quadra.service';

/** CON-018 — o campo da afirmação, no formulário e não na query string. */
export const CAMPO_DA_CONFIRMACAO = 'semPessoasIdentificaveis';

/**
 * SPEC-018/TASK-005 — upload da imagem da quadra.
 *
 * **Por que o `@Roles` não inclui `super_admin`, ao contrário da logo.** A
 * tabela de atores da spec dá imagem de quadra ao `company_admin`, e só. A
 * razão é estrutural: `super_admin` não tem empresa, e a chave começa por
 * `empresas/<company_id>/` (LIM-005). Além disso a rota **registra quem
 * confirmou** — e a confirmação é sobre a quadra de um clube, feita por
 * alguém daquele clube.
 *
 * **A regra que custou uma tela inteira em 2026-08-25 vale aqui: a tabela
 * de atores manda, a coluna "Quem" do contrato a repete, não a amplia.**
 *
 * `ParseUUIDPipe` na frente: id malformado é 400 antes de qualquer consulta,
 * e o parser da chave nunca recebe algo que não seja UUID.
 */
@ApiTags('courts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('courts/:id/imagem')
export class CourtImageController {
  constructor(private readonly imagens: ImagemDaQuadraService) {}

  /**
   * **A confirmação chega por `@Body()`, não por DTO com `class-validator`.**
   * O corpo é `multipart/form-data`, e o pipe de validação global não roda
   * sobre campo de multipart do mesmo jeito que sobre JSON — um DTO aqui
   * daria a impressão de estar validando sem estar. Quem julga o valor é
   * `confirmouSemPessoas()`, que trata explicitamente o caso de multipart
   * mandar a string `"false"` (ver o serviço).
   */
  @Put()
  @Roles('company_admin')
  @UploadDeMidia()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [CAMPO_DO_ARQUIVO, CAMPO_DA_CONFIRMACAO],
      properties: {
        [CAMPO_DO_ARQUIVO]: { type: 'string', format: 'binary' },
        [CAMPO_DA_CONFIRMACAO]: {
          type: 'string',
          enum: ['true'],
          description:
            'AC-007 — afirmação de que a imagem não mostra pessoas identificáveis. Sem ela, 422 CONFIRMACAO_OBRIGATORIA e nada é gravado.',
        },
      },
    },
  })
  substituir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
    @Body() corpo: Record<string, unknown>,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    return this.imagens.substituir(
      id,
      user,
      exigirArquivo(arquivo),
      corpo?.[CAMPO_DA_CONFIRMACAO],
    );
  }

  /**
   * AC-010 — apagar sem substituir. Devolve a imagem resolvida (que passa a
   * ser `null`) em vez de 204, pela mesma razão da logo: quem removeu quer
   * saber o que a tela vai mostrar agora.
   */
  @Delete()
  @Roles('company_admin')
  remover(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ) {
    return this.imagens.remover(id, user);
  }
}

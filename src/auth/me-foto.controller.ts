import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';
import {
  CAMPO_DO_ARQUIVO,
  exigirArquivo,
  UploadDeMidia,
} from '../storage/upload-de-midia';
import { FotoDePerfilService } from './foto-de-perfil.service';

/**
 * SPEC-018/TASK-003 — `/me/foto`.
 *
 * **Não há id na URL, e é essa a implementação da AC-004.** "Um usuário só
 * sobe a própria foto" não é conferido por comparação — não existe caminho
 * pelo qual outro id chegue aqui. Guarda que compara `params.id` com
 * `token.sub` é guarda que alguém pode esquecer de escrever na rota
 * seguinte; rota sem parâmetro não tem como ser esquecida. Mesmo raciocínio
 * de `me/company` e `me/teacher`.
 *
 * **Sem `RolesGuard`**: qualquer autenticado com empresa tem perfil —
 * `aluno`, `professor` e `company_admin`. Quem não tem empresa é recusado
 * pelo serviço, com 403 `PERFIL_SEM_EMPRESA` e motivo dito (AC-022), e não
 * por lista de papéis, que envelheceria a cada papel novo.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/foto')
export class MeFotoController {
  constructor(private readonly fotos: FotoDePerfilService) {}

  /**
   * **Esta rota não está na tabela de contrato da spec, e a adição é
   * deliberada.** A spec lista `PUT` e `DELETE`; sem um `GET`, a AC-003
   * ("vem por URL assinada; passados 15 min, 403") não teria por onde
   * acontecer.
   *
   * E ela é um `GET` próprio em vez de um campo em `/auth/me` justamente
   * **porque a URL expira**: embutida na resposta de login, ficaria velha
   * numa sessão longa e a tela mostraria imagem quebrada sem ter como se
   * recuperar. Endpoint próprio é o que dá ao frontend como pedir de novo.
   */
  @Get()
  ler(@CurrentUser() user: AccessTokenPayload) {
    return this.fotos.ler(user.sub);
  }

  @Put()
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
    @CurrentUser() user: AccessTokenPayload,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    return this.fotos.substituir(user.sub, exigirArquivo(arquivo));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remover(@CurrentUser() user: AccessTokenPayload) {
    return this.fotos.remover(user.sub);
  }
}

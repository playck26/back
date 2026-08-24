import {
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Query,
  UnprocessableEntityException,
  UploadedFile,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  montarChave,
  visibilidadeDe,
  type TipoDeMidia,
} from '../../src/storage/chave-de-midia';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../src/storage/storage-provider.interface';
import { StorageService } from '../../src/storage/storage.service';
import {
  exigirArquivo,
  UploadDeMidia,
} from '../../src/storage/upload-de-midia';
import { validarWebp } from '../../src/storage/webp.validator';

/**
 * SPEC-017/TASK-002b — o controller de teste do FIT-006.
 *
 * **Ele mora em `test/` e é por isso que ele é seguro.** A 5ª rodada de
 * validação pegou uma incoerência: o FIT-006 exige provar 413, retry e URL
 * pública e privada — coisas de rota — numa spec que declara não ter rota
 * nenhuma. A saída não foi criar uma rota "temporária" em produção: rota
 * temporária nunca é temporária, e uma que aceita upload sem dono é
 * superfície de ataque esperando uso.
 *
 * O que precisa ser real é o `StorageService`, o interceptor, o validador e
 * o bucket — e todos são. **A configuração de upload vem da mesma fonte que
 * as rotas da SPEC-018 vão usar** (`@UploadDeMidia()`, INV-048): fixture com
 * configuração própria deixaria o FIT-006 verde provando o que a produção
 * não faz.
 *
 * **Sem guard de autenticação, e isso é deliberado:** a etapa de auth do
 * CON-017.1 é definida pela SPEC-018, que é quem tem dono para o recurso.
 * Aqui o dono é fictício, e um guard falso provaria menos que nenhum.
 */

/**
 * Empresa e recurso fictícios: não existem no banco, e não precisam.
 * Hexadecimal de verdade — o parser recusa qualquer coisa que não seja UUID
 * canônico, inclusive um id "fictício" com letra fora de `[0-9a-f]`.
 */
export const EMPRESA_FIXTURE = 'f1c70000-0000-4000-8000-000000000001';
export const RECURSO_FIXTURE = 'f1c70000-0000-4000-8000-000000000002';

@Controller('fixture')
export class FixtureUploadController {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
    private readonly storage: StorageService,
  ) {}

  @Put(':tipo')
  @UploadDeMidia()
  async subir(
    @Param('tipo') tipo: TipoDeMidia,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    const corpo = exigirArquivo(arquivo);

    const validacao = validarWebp(corpo);
    if (!validacao.valido) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: validacao.codigo,
        message: validacao.motivo,
      });
    }

    // A chave é o CONTEÚDO (AC-007): é o que torna o retry inofensivo.
    const sha256 = createHash('sha256').update(corpo).digest('hex');
    const key = montarChave({
      companyId: EMPRESA_FIXTURE,
      tipo,
      recursoId: RECURSO_FIXTURE,
      sha256,
    });
    if (key === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'TIPO_DE_MIDIA_DESCONHECIDO',
        message: 'Tipo de mídia desconhecido.',
      });
    }

    await this.provider.gravar({
      key,
      corpo,
      contentType: 'image/webp',
      visibilidade: visibilidadeDe(tipo),
    });

    return { key, largura: validacao.largura, altura: validacao.altura };
  }

  @Get(':tipo')
  async ler(@Param('tipo') tipo: TipoDeMidia, @Query('key') key?: string) {
    // `key` vem cru de propósito: é o lugar onde o FIT-006 injeta chave
    // adulterada e exige 404.
    const url = await this.storage.urlDeLeitura({
      key,
      companyId: EMPRESA_FIXTURE,
      tipo,
      recursoId: RECURSO_FIXTURE,
    });
    return { url };
  }
}

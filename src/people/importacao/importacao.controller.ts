import {
  Body,
  Controller,
  Post,
  Query,
  UseGuards,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CompanyAdminGuard } from '../../common/guards/company-admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.type';
import {
  CAMPO_DO_ARQUIVO,
  UploadDeMidia,
  exigirArquivo,
} from '../../storage/upload-de-midia';
import {
  ImportacaoConcluidaDto,
  RelatorioDeImportacaoDto,
} from './dto/importacao-response.dto';
import {
  ImportacaoDeAlunosService,
  traduzirErroDaImportacao,
} from './importacao-de-alunos.service';

/**
 * SPEC-083/D2 -- **a codificacao vem dos bytes, e nao de um palpite.**
 *
 * Primeiro UTF-8 **estrito** (`fatal: true`): um byte que nao forma UTF-8
 * valido lanca, em vez de virar `\uFFFD` em silencio. Se lancar, os bytes sao
 * lidos como `windows-1252`, que e o que o Excel grava em "CSV (separado por
 * virgulas)" no Windows em portugues.
 *
 * *Por que a ordem importa:* `windows-1252` aceita **qualquer** sequencia de
 * bytes, entao ele nunca pode ir primeiro -- leria um UTF-8 legitimo como
 * mojibake (o `a` com til virando dois caracteres). O UTF-8 estrito e o unico
 * dos dois que sabe dizer "nao sou eu". Antes desta spec, um nome acentuado
 * gravado pelo Excel chegava com `\uFFFD` no lugar do acento, e o nivel
 * acentuado da planilha nunca casava com o cadastrado.
 *
 * `ignoreBOM: true` deixa o BOM passar para o analisador, que continua sendo
 * quem o remove (D2). Sem ele, o decodificador o engoliria aqui, e a remocao
 * do analisador viraria codigo morto justamente no caminho do HTTP.
 *
 * Outra codificacao, como o UTF-16 do "Texto Unicode" do Excel, cai no
 * `windows-1252` e vira `COLUNA_DESCONHECIDA` no cabecalho (LIM-083g).
 */
export function decodificarPlanilha(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * SPEC-038 — importar alunos por planilha.
 *
 * ## Reusa o `@UploadDeMidia()`, e o nome dele fica um pouco largo
 *
 * CSV nao e "midia", e o decorator continua sendo o certo: **a INV-048 existe
 * para nao haver duas configuracoes de upload no projeto**. Ela nasceu porque
 * um controller de teste que monta o interceptor "do seu jeito" deixa o
 * FIT-006 verde provando o que a producao nao faz.
 *
 * O que vem junto e o que importa: mesmo campo (`arquivo`), mesmo teto de 2 MB
 * com os DOIS portoes (Content-Length e streaming), e os mesmos codigos de
 * erro. Uma planilha de 300 alunos tem ~20 KB.
 *
 * ## Uma rota, dois comportamentos, e o parametro decide (D2)
 *
 * `?conferir=true` valida e **nao escreve**; sem ele, valida e escreve. Duas
 * rotas separadas diriam a mesma coisa e abririam a chance de a validacao de
 * uma divergir da outra -- e a que divergisse seria justamente a que escreve.
 */
/**
 * `@ApiExtraModels` porque a resposta e uma UNIAO e o Nest so reflete o tipo
 * declarado. Sem ele, `ImportacaoConcluidaDto` nao entra no `openapi.json` --
 * e o frontend, que gera os tipos dali, nao teria como nomear o que recebe
 * depois de importar. Foi o `tsc` do Admin que apontou a falta.
 */
@ApiExtraModels(RelatorioDeImportacaoDto, ImportacaoConcluidaDto)
@ApiTags('alunos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyAdminGuard)
@Controller('students/importar')
export class ImportacaoController {
  constructor(private readonly importacao: ImportacaoDeAlunosService) {}

  @Post()
  @UploadDeMidia()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        [CAMPO_DO_ARQUIVO]: { type: 'string', format: 'binary' },
        // SPEC-083/D5 — quem recebe convite por e-mail, escolhido na
        // conferência. Ausente: ninguém, e todas as linhas ganham senha.
        convidar: {
          type: 'string',
          example: '3,5,9',
          description:
            'Números de linha da planilha (contando o cabeçalho), separados por vírgula, que recebem convite por e-mail em vez de senha temporária. Um número que não é linha válida do arquivo responde 400 CONVIDAR_LINHA_INVALIDA, e nada é escrito. Ignorado com conferir=true.',
        },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(RelatorioDeImportacaoDto) },
        { $ref: getSchemaPath(ImportacaoConcluidaDto) },
      ],
    },
  })
  async importar(
    @CurrentUser() user: AccessTokenPayload,
    @Query('conferir') conferir?: string,
    @UploadedFile() arquivo?: Express.Multer.File,
    @Body('convidar') convidar?: string,
  ): Promise<RelatorioDeImportacaoDto | ImportacaoConcluidaDto> {
    // SPEC-083/D2: UTF-8 estrito, e `windows-1252` se os bytes nao forem
    // UTF-8 valido. Era `toString('utf8')`, que troca o byte invalido por
    // `\uFFFD` e nao avisa ninguem.
    const conteudo = decodificarPlanilha(exigirArquivo(arquivo));
    const companyId = user.companyId as string;

    if (conferir === 'true') {
      return this.importacao.conferir(companyId, conteudo);
    }
    // SPEC-083/D3, passo 5 \u2014 a traducao mora AQUI, na borda, como na D4 da
    // SPEC-082: o servico lanca o erro do banco com a etapa marcada, e so a
    // resposta ao cliente vira 409/503. O `23505` ja chega decidido.
    try {
      return await this.importacao.importar(companyId, conteudo, {
        // O gestor e o `criado_por_id` dos convites, e uma das linhas que a
        // importacao trava antes de escrever (D3, passo 2).
        gestorId: user.sub,
        convidar,
      });
    } catch (erro) {
      return traduzirErroDaImportacao(erro);
    }
  }
}

import {
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
import { ImportacaoDeAlunosService } from './importacao-de-alunos.service';

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
  ): Promise<RelatorioDeImportacaoDto | ImportacaoConcluidaDto> {
    // `utf8` explicito: o Excel exporta com BOM, e o analisador o remove --
    // mas so se o texto chegar como texto. `toString()` sem encoding usa o
    // default do Node, que hoje e utf8 e nao e contrato.
    const conteudo = exigirArquivo(arquivo).toString('utf8');
    const companyId = user.companyId as string;

    return conferir === 'true'
      ? this.importacao.conferir(companyId, conteudo)
      : this.importacao.importar(companyId, conteudo);
  }
}

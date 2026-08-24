import {
  applyDecorators,
  ArgumentsHost,
  BadRequestException,
  Catch,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

/**
 * SPEC-017/TASK-002b — **a fonte única da configuração de upload** (INV-048).
 *
 * O problema que esta invariante resolve foi achado na 6ª rodada de
 * validação da spec: a SPEC-017 entrega um **controller de teste** para o
 * FIT-006 exercitar, e um controller de teste que monta o interceptor "do
 * meu jeito" deixa o FIT-006 verde provando o que a produção não faz.
 *
 * Por isso a configuração não é um objeto que cada rota copia — é **um
 * decorator**. A rota real da SPEC-018 escreve `@UploadDeMidia()` e recebe
 * exatamente o que o fixture recebe: mesmo limite, mesmo nome de campo,
 * mesma tradução de erro. Duas configurações é o fixture provando o que a
 * produção não faz.
 */

/** CON-017.1 — o campo do arquivo, em todo upload de mídia do produto. */
export const CAMPO_DO_ARQUIVO = 'arquivo';

/** AC-006 — 2 MB. Acima disso é 413, e nada é gravado. */
export const TAMANHO_MAXIMO_BYTES = 2 * 1024 * 1024;

export const CORPO_GRANDE_DEMAIS = {
  statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
  code: 'CORPO_GRANDE_DEMAIS',
  message: `Arquivo acima de ${TAMANHO_MAXIMO_BYTES} bytes.`,
} as const;

export const CAMPO_INESPERADO = {
  statusCode: HttpStatus.BAD_REQUEST,
  code: 'CAMPO_INESPERADO',
  message: `Envie o arquivo no campo "${CAMPO_DO_ARQUIVO}".`,
} as const;

/**
 * O primeiro dos dois portões de tamanho: recusa pelo `Content-Length`
 * **antes de o corpo ser consumido**.
 *
 * Guard e não interceptor de propósito: no Nest, guard roda **antes** do
 * interceptor, e é essa ordem que faz o 413 acontecer sem o Multer chegar a
 * abrir o stream. Cliente honesto manda `Content-Length`, e para ele o
 * arquivo grande nunca sai da rede.
 */
@Injectable()
export class TamanhoDeCorpoGuard implements CanActivate {
  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto.switchToHttp().getRequest<Request>();
    const declarado = Number(req.headers['content-length']);
    // `NaN` (header ausente, corpo em chunked) NÃO recusa aqui: quem cuida
    // desse caso é o `limits.fileSize` do Multer, durante o streaming. São
    // dois portões porque são dois cenários, e nenhum deles cobre o outro.
    if (Number.isFinite(declarado) && declarado > TAMANHO_MAXIMO_BYTES) {
      throw new PayloadTooLargeException(CORPO_GRANDE_DEMAIS);
    }
    return true;
  }
}

/**
 * O segundo portão de tamanho, e a forma do erro.
 *
 * **O status já vem certo do Nest**, e isso foi medido, não suposto: o
 * `transformException` do `@nestjs/platform-express` traduz `MulterError`
 * antes de qualquer filtro nosso — `LIMIT_FILE_SIZE` vira 413,
 * `LIMIT_UNEXPECTED_FILE` vira 400. A primeira versão deste arquivo tinha um
 * `@Catch(MulterError)` que **nunca era alcançado**, e o teste mostrou:
 * status certo, corpo do Nest, sem o nosso `code`.
 *
 * O que falta, e é o que este filtro faz, é o **`code` estável** — convenção
 * do projeto para erro de domínio (`FORA_DO_EXPEDIENTE`, `SENHA_TEMPORARIA`
 * e companhia). Frontend que decide por string de mensagem quebra na
 * primeira revisão de texto.
 *
 * **Não há ramo para `MulterError` aqui.** Se um dia o Nest parar de
 * traduzir, o erro vira 500 e as suítes de contrato reprovam — o que é
 * melhor que um ramo que ninguém exercita e ninguém sabe se funciona.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class ErroDeUploadFilter implements ExceptionFilter {
  catch(
    erro: PayloadTooLargeException | BadRequestException,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();
    const corpo =
      erro instanceof PayloadTooLargeException
        ? CORPO_GRANDE_DEMAIS
        : CAMPO_INESPERADO;
    res.status(corpo.statusCode).json(corpo);
  }
}

/**
 * A configuração do Multer. **Memória, nunca disco**: o arquivo é validado
 * e mandado para o Spaces; gravar em disco criaria um estado intermediário
 * que ninguém limpa quando a validação recusa (AC-006 exige "nada gravado").
 *
 * O teto de 2 MB e o de 1 arquivo são os dois limites que o NFR-001 depende:
 * a API roda em 512 MB, e o pico por upload precisa ficar abaixo de 5 MB.
 */
export function opcoesDeUpload() {
  return {
    // Sem `storage`: o default do Multer é memória, e é o que queremos.
    limits: {
      fileSize: TAMANHO_MAXIMO_BYTES,
      files: 1,
      // Sem campos de texto extras: o que a rota precisa saber vem da URL e
      // do token, nunca do corpo multipart.
      fields: 2,
      parts: 3,
    },
  };
}

/**
 * **É isto que a rota real e o fixture compartilham.** Aplicar este decorator
 * é a única forma suportada de aceitar upload de mídia neste projeto.
 */
export function UploadDeMidia(): MethodDecorator {
  return applyDecorators(
    UseGuards(TamanhoDeCorpoGuard),
    UseFilters(ErroDeUploadFilter),
    UseInterceptors(FileInterceptor(CAMPO_DO_ARQUIVO, opcoesDeUpload())),
  );
}

/**
 * Recusa a ausência do arquivo com o mesmo código de campo errado: para quem
 * chama, "mandou no campo errado" e "não mandou" são o mesmo defeito.
 */
export function exigirArquivo(arquivo?: Express.Multer.File): Buffer {
  if (!arquivo || !Buffer.isBuffer(arquivo.buffer)) {
    throw new BadRequestException(CAMPO_INESPERADO);
  }
  return arquivo.buffer;
}

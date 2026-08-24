import {
  applyDecorators,
  BadRequestException,
  CallHandler,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

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
 * O segundo portão de tamanho, e a tradução do erro — **na origem, não na
 * rota**.
 *
 * A primeira versão era um `@UseFilters(@Catch(PayloadTooLargeException,
 * BadRequestException))`. Funcionava para o upload e **mascarava tudo o mais
 * que a rota recusasse**: a validação cruzada de 2026-08-24 montou uma rota
 * com `ParseUUIDPipe` e um id inválido virou *"Envie o arquivo no campo
 * arquivo"*. Reproduzido antes de corrigir.
 *
 * O erro do filtro era de posição: ele capturava **por tipo, no escopo da
 * rota**, e no escopo da rota `BadRequestException` significa qualquer coisa.
 * Traduzir aqui, em volta do interceptor que **produz** o erro, só alcança o
 * que veio do upload — e o que a rota recusar por conta própria passa
 * intacto.
 *
 * **O status já vem certo do Nest**, e isso foi medido: o
 * `transformException` do `@nestjs/platform-express` traduz `MulterError`
 * antes de qualquer coisa nossa — `LIMIT_FILE_SIZE` vira 413,
 * `LIMIT_UNEXPECTED_FILE` vira 400. O que falta é o **`code` estável**, que é
 * a convenção do projeto para erro de domínio; frontend que decide por
 * string de mensagem quebra na primeira revisão de texto.
 */
export function InterceptorDeMidia(): Type<NestInterceptor> {
  const Base = FileInterceptor(CAMPO_DO_ARQUIVO, opcoesDeUpload());

  @Injectable()
  class InterceptorComErroTraduzido extends Base {
    async intercept(
      contexto: ExecutionContext,
      proximo: CallHandler,
    ): Promise<Observable<unknown>> {
      try {
        return (await super.intercept(
          contexto,
          proximo,
        )) as Observable<unknown>;
      } catch (erro) {
        throw traduzirErroDeUpload(erro);
      }
    }
  }

  return InterceptorComErroTraduzido;
}

/** Só é chamada com erro vindo do interceptor de upload. */
export function traduzirErroDeUpload(erro: unknown): unknown {
  if (erro instanceof PayloadTooLargeException) {
    return new PayloadTooLargeException(CORPO_GRANDE_DEMAIS);
  }
  if (erro instanceof BadRequestException) {
    return new BadRequestException(CAMPO_INESPERADO);
  }
  // Qualquer outra coisa sobe como está: inventar `code` para erro que não
  // conhecemos é dizer ao cliente que sabemos o que aconteceu.
  return erro;
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
  // **Sem `UseFilters`**: filtro de rota captura por tipo, e no escopo da
  // rota `BadRequestException` significa qualquer coisa. Ver acima.
  return applyDecorators(
    UseGuards(TamanhoDeCorpoGuard),
    UseInterceptors(InterceptorDeMidia()),
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

import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * SPEC-054/D11 — **Entrega A: o código que entende a recusa sobe antes de a
 * recusa existir.**
 *
 * As triggers de estoque da Entrega B recusam com dois SQLSTATE próprios. Se o
 * `back` não os conhecer — rollback de B, ou contêiner antigo durante o deploy —,
 * o catch da criação e o do movimento os tratam como corrida perdida
 * (`ehCorridaPerdida` aceita qualquer erro do Prisma fora da lista de
 * infraestrutura), retentam e relançam: `500` numa recusa normal de negócio.
 */
export const SQLSTATE_ESTOQUE_ESGOTADO = 'P3303';
export const SQLSTATE_ADICIONAL_INATIVO = 'P3304';

/**
 * Como o erro de conector aparece dentro da mensagem da API de modelo. Medido
 * em 2026-09-15 (Prisma 6.19.3, PostgreSQL 18.4):
 *
 *     ConnectorError(... QueryError(PostgresError { code: "P3303", message: ...
 */
const SQLSTATE_NA_MENSAGEM = /PostgresError \{ code: "([0-9A-Z]{5})"/;

/**
 * O SQLSTATE do Postgres, nas **duas** representações do Prisma (fato 8):
 *
 * - **SQL cru** → `PrismaClientKnownRequestError` `P2010`, com `meta.code`;
 * - **API de modelo** → `PrismaClientUnknownRequestError`, **sem `code` nem
 *   `meta`**: o SQLSTATE só existe no texto da mensagem.
 *
 * Ler só `code`/`meta` deixa a API de modelo — que é o que a criação e o
 * movimento usam — virar corrida perdida. **Casar texto é o último recurso**, e
 * fica contido: só em erro do Prisma, só no formato medido, e o db-spec afirma a
 * representação — se o Prisma mudar, o teste avisa antes de a tradução sumir.
 *
 * Erro que não veio do Prisma não tem SQLSTATE, nem com o texto parecido.
 */
export function sqlstateDoErro(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as
      { code?: unknown; db_error_code?: unknown } | undefined;
    const doMeta = meta?.code ?? meta?.db_error_code;
    return typeof doMeta === 'string' ? doMeta : undefined;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return SQLSTATE_NA_MENSAGEM.exec(error.message)?.[1];
  }
  return undefined;
}

/** A trigger nomeia o adicional na mensagem: `ESTOQUE_ESGOTADO adicional=<uuid>`. */
const ADICIONAL_NA_MENSAGEM =
  /adicional=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * Traduz a recusa de estoque em HTTP, e **não faz nada** com qualquer outro
 * erro — quem chama segue para a trava do professor e para a corrida perdida.
 *
 * Tem de vir **antes** de `ehCorridaPerdida`: depois, a criação e o movimento
 * já teriam retentado uma transação inteira por uma recusa que se repete igual.
 *
 * `disponivel` não sai daqui: dentro da transação recusada não há mais o que
 * ler. A Entrega B o calcula numa consulta nova, depois do `ROLLBACK` (D7).
 */
export function traduzirRecusaDeEstoque(error: unknown): void {
  const sqlstate = sqlstateDoErro(error);
  if (
    sqlstate !== SQLSTATE_ESTOQUE_ESGOTADO &&
    sqlstate !== SQLSTATE_ADICIONAL_INATIVO
  ) {
    return;
  }
  const adicionalId =
    ADICIONAL_NA_MENSAGEM.exec((error as Error).message)?.[1] ?? undefined;

  if (sqlstate === SQLSTATE_ESTOQUE_ESGOTADO) {
    throw new ConflictException({
      statusCode: 409,
      code: 'ESTOQUE_ESGOTADO',
      message:
        'Um adicional desta reserva não tem unidade livre neste horário.',
      adicionalId,
    });
  }
  throw new UnprocessableEntityException({
    statusCode: 422,
    code: 'ADICIONAL_INATIVO',
    message: 'Um adicional desta reserva não está mais sendo oferecido.',
    adicionalId,
  });
}

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sqlstateDoErro } from './recusas-de-estoque';

/**
 * SPEC-054/D10 — **cada recusa do catálogo tem código, e o banco é a rede.**
 *
 * A aplicação confere antes (nome repetido, tipo de outra empresa, tipo em
 * uso) e responde com o código. O que escapar da conferência — uma corrida
 * entre a contagem e a escrita — o banco recusa, e esta função devolve **a
 * mesma resposta** que a conferência daria.
 *
 * ## A classificação é pela OPERAÇÃO, não pelo nome da constraint
 *
 * O nome nem sempre vem (fato 8): pela API de modelo, `UNIQUE` chega como
 * `P2002` com `meta.target` (as COLUNAS), FK num `update` como `P2003`, e o
 * `DELETE` barrado por `RESTRICT` como erro desconhecido com `23001` só na
 * mensagem. Cada operação alcança **uma** recusa de negócio de cada classe
 * (conferido contra o catálogo do banco na 3ª rodada), então saber o que o
 * serviço fez basta para saber o que o banco recusou.
 *
 * **Qualquer representação fora da tabela é relançada** — vira `500` e
 * aparece —, nunca traduzida por palpite.
 *
 * ## O limite do `23514`
 *
 * `CHECK` recusado vira `400 VALOR_INVALIDO` **só nestas operações**. Um `23514`
 * das triggers de item, de ocupação ou do ledger tem outro contrato (matriz da
 * spec), e por isso esta função **nunca** é chamada no caminho da reserva.
 */
export type OperacaoDoCatalogo =
  | 'criar-tipo'
  | 'renomear-tipo'
  | 'apagar-tipo'
  | 'criar-adicional'
  | 'editar-adicional'
  | 'nomes-de-tipo';

/** O `P2002` é de nome só quando o alvo, se vier, contém a coluna `nome`. */
function ehColisaoDeNome(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const alvo = (error.meta as { target?: unknown } | undefined)?.target;
      // Medido: `[company_id, nome]`. Um `P2002` em `[id]` não é de negócio.
      return Array.isArray(alvo) ? alvo.includes('nome') : alvo === undefined;
    }
  }
  return sqlstateDoErro(error) === '23505';
}

/**
 * `23514` **de `CHECK`**, e não de trigger. As triggers de item, de ocupação e do
 * ledger também levantam `23514` (`RAISE … USING ERRCODE`), com outro contrato; a
 * mensagem do Postgres para `CHECK` é a única que diz *"violates check
 * constraint"* — nas duas representações do Prisma (medido na AC-038).
 */
function ehCheckViolado(error: unknown): boolean {
  return (
    sqlstateDoErro(error) === '23514' &&
    error instanceof Error &&
    /violates check constraint/.test(error.message)
  );
}

function ehFkViolada(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003'
  ) {
    return true;
  }
  return sqlstateDoErro(error) === '23503';
}

/**
 * Traduz a recusa do banco de uma operação do catálogo, ou relança.
 *
 * `emUso` é chamado só no `23001` de apagar tipo, para a resposta trazer a
 * contagem **depois** da recusa — dentro da operação recusada não havia o
 * número certo.
 */
export async function traduzirRecusaDoCatalogo(
  error: unknown,
  operacao: OperacaoDoCatalogo,
  emUso?: () => Promise<number>,
): Promise<never> {
  const ehDeTipo = operacao === 'criar-tipo' || operacao === 'renomear-tipo';
  const ehDeAdicional =
    operacao === 'criar-adicional' || operacao === 'editar-adicional';

  if ((ehDeTipo || ehDeAdicional) && ehColisaoDeNome(error)) {
    throw ehDeTipo ? tipoJaExiste() : adicionalJaExiste();
  }

  if (ehDeAdicional && ehFkViolada(error)) {
    throw tipoNaoEncontrado();
  }

  if (operacao === 'apagar-tipo' && sqlstateDoErro(error) === '23001') {
    throw tipoEmUso(emUso ? await emUso() : undefined);
  }

  if (ehCheckViolado(error)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'VALOR_INVALIDO',
      // Não aponta o campo: no caminho normal o DTO já recusou COM o campo. Esta
      // resposta só existe se DTO e `CHECK` divergirem.
      message: 'Um dos valores enviados não é aceito.',
    });
  }

  throw error;
}

export function tipoJaExiste() {
  return new ConflictException({
    statusCode: 409,
    code: 'TIPO_JA_EXISTE',
    message: 'Já existe um tipo de adicional com este nome.',
  });
}

export function adicionalJaExiste() {
  return new ConflictException({
    statusCode: 409,
    code: 'ADICIONAL_JA_EXISTE',
    message: 'Já existe um adicional com este nome.',
  });
}

export function tipoNaoEncontrado() {
  // 404, e não 403: o tipo de outra empresa recebe o mesmo que o que não existe.
  return new NotFoundException({
    statusCode: 404,
    code: 'TIPO_NAO_ENCONTRADO',
    message: 'Tipo de adicional não encontrado.',
  });
}

export function adicionalNaoEncontrado() {
  return new NotFoundException({
    statusCode: 404,
    code: 'ADICIONAL_NAO_ENCONTRADO',
    message: 'Adicional não encontrado.',
  });
}

export function tipoEmUso(adicionais: number | undefined) {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'TIPO_EM_USO',
    message:
      adicionais === undefined
        ? 'Este tipo tem adicionais e não pode ser apagado.'
        : `Este tipo tem ${adicionais} adicional(is) e não pode ser apagado. Mova ou desative os adicionais antes.`,
    adicionais,
  });
}

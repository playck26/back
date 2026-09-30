import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * SPEC-082/D4 — **erro de espera e de infraestrutura nas rotas de matrícula
 * vira resposta com código, nunca 500.**
 *
 * A lista de códigos de infraestrutura morava em `courts.service.ts` (DEF-013);
 * mora aqui agora, num lugar só, e o `courts.service.ts` a importa.
 */
export const CODIGOS_DE_INFRA = new Set([
  'P1001', // servidor inalcançável
  'P1002', // timeout ao abrir conexão
  'P1008', // timeout de operação
  'P1017', // o servidor encerrou a conexão
  'P2024', // esgotou o pool esperando conexão
  'P2028', // transação expirada ou já fechada
]);

/** Os dois que viram 503 nas rotas de matrícula (REQ-003). */
export const CODIGOS_DE_SERVIDOR_OCUPADO = new Set(['P2024', 'P2028']);

/** I4 — a espera foi pela linha da TURMA (outra pessoa entrando nela). */
export const MENSAGEM_OUTRA_PESSOA_NA_TURMA =
  'Outra pessoa está entrando nesta turma agora. Tente de novo em alguns segundos.';

/** I6/I8 — a espera foi por um pedido do próprio aluno ou do clube. */
export const MENSAGEM_ALTERACAO_EM_ANDAMENTO =
  'Já existe uma alteração em andamento na sua matrícula ou no clube. Tente de novo em alguns segundos.';

/** I5 — o tempo-limite da transação ou o pool esgotado. */
export const MENSAGEM_SERVIDOR_OCUPADO =
  'O sistema está com muita procura agora. Tente de novo em alguns segundos.';

/**
 * Onde a espera nasceu. **A causa vem da etapa, não do texto do Postgres**
 * (D4): o serviço marca a etapa antes de cada instrução que pode esperar.
 * Tudo o que não for marcado é "outra" — e "outra" é a I6.
 */
export type EtapaDaMatricula = 'travas' | 'turma' | 'fila' | 'outra';

const ETAPA = Symbol.for('playck.spec082.etapa');

/**
 * Roda a instrução e, se ela falhar, carimba a etapa no erro (a primeira
 * etapa carimbada vence: o erro de uma instrução interna não é reetiquetado
 * por quem a envolve).
 */
export async function naEtapa<T>(
  etapa: EtapaDaMatricula,
  instrucao: Promise<T>,
): Promise<T> {
  try {
    return await instrucao;
  } catch (erro) {
    if (erro !== null && typeof erro === 'object' && !(ETAPA in erro)) {
      Object.defineProperty(erro, ETAPA, { value: etapa, enumerable: false });
    }
    throw erro;
  }
}

export function etapaDoErro(erro: unknown): EtapaDaMatricula {
  if (erro !== null && typeof erro === 'object' && ETAPA in erro) {
    return (erro as Record<symbol, EtapaDaMatricula>)[ETAPA];
  }
  return 'outra';
}

const SQLSTATE_NA_MENSAGEM = /PostgresError \{ code: "([0-9A-Z]{5})"/;

/** O SQLSTATE nas duas representações do Prisma (cru: `meta.code`; modelo: texto). */
export function sqlstateDe(erro: unknown): string | undefined {
  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = erro.meta as
      { code?: unknown; db_error_code?: unknown } | undefined;
    const doMeta = meta?.code ?? meta?.db_error_code;
    return typeof doMeta === 'string' ? doMeta : undefined;
  }
  if (erro instanceof Prisma.PrismaClientUnknownRequestError) {
    return SQLSTATE_NA_MENSAGEM.exec(erro.message)?.[1];
  }
  return undefined;
}

/** `55P03` — `lock_not_available`, o que o `lock_timeout` produz. */
export function ehEsperaEstourada(erro: unknown): boolean {
  return sqlstateDe(erro) === '55P03';
}

export function ehServidorOcupado(erro: unknown): boolean {
  return (
    erro instanceof Prisma.PrismaClientKnownRequestError &&
    CODIGOS_DE_SERVIDOR_OCUPADO.has(erro.code)
  );
}

/**
 * A tradução das três rotas leitoras (`entrar`, `allocateStudent`,
 * `confirmar`). **Mora na borda HTTP**, e não no serviço: o serviço continua
 * lançando o erro do banco — que é o que as provas de banco da SPEC-075
 * afirmam (`55P03`) —, e só a resposta ao cliente é traduzida.
 *
 * - `55P03` na linha da turma ⇒ 409 `MATRICULA_EM_ANDAMENTO` + I4;
 * - `55P03` em qualquer outra etapa ⇒ 409 `MATRICULA_EM_ANDAMENTO` + I6 (I8);
 * - `P2028`/`P2024` ⇒ 503 `SERVIDOR_OCUPADO` + I5;
 * - qualquer outro erro sobe como veio.
 */
export function traduzirErroDaMatricula(erro: unknown): never {
  if (ehEsperaEstourada(erro)) {
    throw new ConflictException(
      {
        statusCode: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message:
          etapaDoErro(erro) === 'turma'
            ? MENSAGEM_OUTRA_PESSOA_NA_TURMA
            : MENSAGEM_ALTERACAO_EM_ANDAMENTO,
      },
      { cause: erro },
    );
  }
  if (ehServidorOcupado(erro)) {
    throw new ServiceUnavailableException(
      {
        statusCode: 503,
        code: 'SERVIDOR_OCUPADO',
        message: MENSAGEM_SERVIDOR_OCUPADO,
      },
      { cause: erro },
    );
  }
  throw erro;
}

/** Envolve a chamada de uma rota leitora com a tradução. */
export async function comTraducaoDaMatricula<T>(
  chamada: () => Promise<T>,
): Promise<T> {
  try {
    return await chamada();
  } catch (erro) {
    return traduzirErroDaMatricula(erro);
  }
}

import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ChaveDeLock,
  ordenarChavesParaLock,
} from '../common/lock/chave-de-lock';
import { MENSAGEM_SERVIDOR_OCUPADO } from '../common/erros/erro-transitorio';
import { sqlstateDoErro } from '../courts/recusas-de-estoque';

/**
 * SPEC-086 — **a trava por e-mail, e o único lugar que monta a chave dela.**
 *
 * A pré-conferência "este e-mail já tem conta?" só vale se ninguém mais puder
 * gravar o mesmo e-mail entre ela e o `COMMIT`. Sem trava, duas transações em
 * empresas diferentes conferem "ausente" ao mesmo tempo e gravam as duas — as
 * três constraints da migration aceitam o par (medido na validação da spec).
 *
 * Por isso **toda transação que cria conta** chama
 * `travarEmailsParaCriarConta` como a PRIMEIRA instrução, e só depois confere.
 *
 * **A chave não tem empresa** (`usuarios.email:<email>`): ela serializa o
 * e-mail ENTRE empresas e entre processos. E é montada só aqui — um prefixo
 * diferente num escritor só faria duas travas que não se enxergam, e tudo
 * passaria até o dia da corrida (DOR-086-R3-03; o teste estrutural confere
 * que o prefixo não aparece em outro arquivo).
 */
const PREFIXO_DA_CHAVE = 'usuarios.email:';

/** O orçamento de espera de TODOS os e-mails da transação, juntos. */
export const PRAZO_DA_TRAVA_DE_EMAIL_MS = 2_000;

/**
 * A espera pela trava de e-mail estourou o orçamento.
 *
 * **Não carrega o `sqlstate`** (nem como `cause`): o `55P03` da matrícula
 * vira `409 MATRICULA_EM_ANDAMENTO`, e nenhum tradutor de matrícula pode
 * reconhecer esta espera como sua. Ela só vira HTTP por
 * `comTraducaoDaTravaDeEmail`.
 */
export class EsperaPorEmailEsgotada extends Error {
  constructor() {
    super('A espera pela trava de e-mail estourou o prazo.');
    this.name = 'EsperaPorEmailEsgotada';
  }
}

/** O cliente da transação: só o que a trava usa. */
export interface ClienteDaTrava {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Prisma.PrismaPromise<T>;
}

export interface MarcoDaTrava {
  ordem: number;
  marcador: string;
}

/** A chave de texto de um e-mail — exata, o mesmo texto que vai à coluna. */
export function chaveDoEmail(email: string): string {
  return PREFIXO_DA_CHAVE + email;
}

/**
 * Trava os e-mails, em ordem, numa instrução só (a função
 * `travar_emails_para_criar_conta` da migration da 086): um orçamento de 2 s
 * para todos, e o `lock_timeout` de antes devolvido no fim.
 *
 * Devolve o diagnóstico por chave (a ordem e o marcador do prazo) — é o que o
 * AC-028 compara.
 */
export async function travarEmailsParaCriarConta(
  tx: ClienteDaTrava,
  emails: readonly string[],
): Promise<MarcoDaTrava[]> {
  const chaves = ordenarChavesParaLock(emails.map(chaveDoEmail)).map((k) =>
    ChaveDeLock.deTexto(k),
  );
  if (chaves.length === 0) return [];
  try {
    return await tx.$queryRaw<MarcoDaTrava[]>`
      SELECT ordem, marcador
        FROM travar_emails_para_criar_conta(
          ${chaves}::bigint[], ${PRAZO_DA_TRAVA_DE_EMAIL_MS}::integer
        )`;
  } catch (erro) {
    if (sqlstateDoErro(erro) === '55P03') throw new EsperaPorEmailEsgotada();
    throw erro;
  }
}

/**
 * Envolve a escrita de uma entrada, **fora** da `$transaction`: a espera
 * esgotada vira `503 SERVIDOR_OCUPADO`, o mesmo corpo que o
 * `erro-transitorio.ts` já usa para o pool esgotado. Roda antes de qualquer
 * outro tradutor da entrada; tudo o mais sobe como veio.
 */
export async function comTraducaoDaTravaDeEmail<T>(
  escrita: () => Promise<T>,
): Promise<T> {
  try {
    return await escrita();
  } catch (erro) {
    if (erro instanceof EsperaPorEmailEsgotada) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'SERVIDOR_OCUPADO',
        message: MENSAGEM_SERVIDOR_OCUPADO,
      });
    }
    throw erro;
  }
}

/**
 * SPEC-086/REQ-005 — a chave `EMAIL_EM_VARIAS_EMPRESAS`. **Padrão desligada.**
 *
 * Desligada, toda entrada recusa um e-mail que exista em qualquer conta, como
 * antes da 086. O login e o `escolher` não a leem: quem já tem duas contas
 * continua entrando se ela for desligada (I8).
 */
export function emailEmVariasEmpresas(): boolean {
  return process.env.EMAIL_EM_VARIAS_EMPRESAS === 'true';
}

const PAPEIS_DE_GESTAO = ['super_admin', 'company_admin'] as const;

/**
 * O filtro da pré-conferência de uma conta de **aluno ou professor** na
 * empresa `companyId`. Qualquer linha que ele ache é conflito — ele não
 * depende de qual linha o banco devolve primeiro.
 *
 * - chave ligada: conta nesta empresa, ou conta de gestão em qualquer lugar;
 * - chave desligada: qualquer conta com o e-mail.
 */
export function conflitoDeContaDaEmpresa(
  email: string,
  companyId: string,
): Prisma.UsuarioWhereInput {
  if (!emailEmVariasEmpresas()) return { email };
  return {
    email,
    OR: [{ companyId }, { role: { in: [...PAPEIS_DE_GESTAO] } }],
  };
}

/** A mesma regra para vários e-mails de uma vez (a importação, em lote). */
export function conflitoDeContasDaEmpresa(
  emails: readonly string[],
  companyId: string,
): Prisma.UsuarioWhereInput {
  if (!emailEmVariasEmpresas()) return { email: { in: [...emails] } };
  return {
    email: { in: [...emails] },
    OR: [{ companyId }, { role: { in: [...PAPEIS_DE_GESTAO] } }],
  };
}

/**
 * O filtro de uma conta de **gestão**: qualquer conta com o e-mail é
 * conflito, com a chave ligada ou não (I5).
 */
export function conflitoDeContaDeGestao(
  email: string,
): Prisma.UsuarioWhereInput {
  return { email };
}

import { randomUUID } from 'node:crypto';
import type { ClienteSql } from './limpar-empresa';

/**
 * SPEC-069/INV-069a — **como uma fixture cria uma AÇÃO legitimamente.**
 *
 * ## Por que este arquivo existe
 *
 * O `acao_exige_alvo` é `DEFERRABLE INITIALLY DEFERRED`: ele julga no
 * `COMMIT`, e exige que a ação tenha ao menos um efeito — ocupação, matrícula,
 * crédito ou turma.
 *
 * **Fora de uma transação explícita, o Postgres dá um commit por statement.**
 * Então `INSERT INTO acoes_administrativas` sozinho commita ali mesmo, o
 * trigger roda, e o efeito ainda não existe. O erro é `acao ... commitada sem
 * efeito`, e ele **não descreve um defeito do produto**: descreve uma fixture
 * em autocommit. Foi assim que 19 arquivos de teste ficaram vermelhos quando o
 * trigger foi aplicado num banco local para medir.
 *
 * ## Por que um helper, e não dezenove correções à mão
 *
 * Mesmo espírito do `cancelarOcupacaoNaFixture` (SPEC-032) e do
 * `limparEmpresa` (DEF-009): **um lugar que sabe fazer certo**, em vez de N
 * lugares que podem errar. A lista de tabelas daquele arquivo já custou caro
 * duas vezes por depender de alguém lembrar.
 *
 * E **não** se resolveu com válvula de teste, como a do append-only: ali a
 * válvula existe para a LIMPEZA poder apagar; aqui, afrouxar seria deixar a
 * fixture fazer o que o produto não pode. A fixture não precisa de exceção —
 * precisa fazer o que o produto faz.
 *
 * ## Como se usa
 *
 * ```ts
 * const acaoId = await comAcao(
 *   db,
 *   { companyId: EMPRESA, tipo: 'credito_lancado', autorId: UADMIN },
 *   (tx, acaoId) => creditos.lancar(tx, { ...params, acaoId }),
 * );
 * ```
 *
 * O efeito recebe o **mesmo `tx`** da ação: é isso que faz as duas escritas
 * caírem no mesmo `COMMIT`, que é a única coisa que o trigger julga.
 */
interface ComTransacao<TX> {
  $transaction<R>(fn: (tx: TX) => Promise<R>): Promise<R>;
}

export interface DadosDaAcao {
  companyId: string;
  /** Um valor de `tipo_de_acao`. */
  tipo: string;
  autorId: string;
  motivo?: string | null;
  /**
   * O id, quando a fixture precisa dele FIXO — e várias precisam: o UUID
   * literal é o que liga a semeadura às asserções. Omitido, sai um `randomUUID`.
   */
  id?: string;
}

/**
 * Cria a ação e o efeito dela **na mesma transação**, e devolve o que o efeito
 * devolveu.
 *
 * O `acaoId` é gerado aqui e entregue ao efeito, em vez de lido por
 * `RETURNING`: o valor precisa existir antes de qualquer um dos dois
 * `INSERT`s, e ler de volta seria uma ida ao banco a mais dentro da transação.
 */
export async function comAcao<TX extends ClienteSql, T>(
  cliente: ComTransacao<TX>,
  dados: DadosDaAcao,
  efeito: (tx: TX, acaoId: string) => Promise<T>,
): Promise<T> {
  const acaoId = dados.id ?? randomUUID();
  return cliente.$transaction(async (tx) => {
    await inserirAcao(tx, acaoId, dados);
    return efeito(tx, acaoId);
  });
}

/**
 * A variante para quem **já está dentro** de uma transação.
 *
 * Aninhar `$transaction` no Prisma não é suportado, e o `tx` que ele entrega
 * nem expõe o método — mesma distinção que o `cancelarOcupacaoNaFixture` faz.
 */
export async function acaoNoTx(
  tx: ClienteSql,
  dados: DadosDaAcao,
): Promise<string> {
  const acaoId = dados.id ?? randomUUID();
  await inserirAcao(tx, acaoId, dados);
  return acaoId;
}

async function inserirAcao(
  tx: ClienteSql,
  acaoId: string,
  dados: DadosDaAcao,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO acoes_administrativas (id, company_id, tipo, autor_id, motivo)
     VALUES ($1::uuid, $2::uuid, $3::tipo_de_acao, $4::uuid, $5)`,
    acaoId,
    dados.companyId,
    dados.tipo,
    dados.autorId,
    dados.motivo ?? null,
  );
}

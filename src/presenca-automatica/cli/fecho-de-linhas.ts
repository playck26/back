import { createHash } from 'node:crypto';

/**
 * SPEC-076/D8 — **o fecho de LINHAS de um conjunto de aulas, lido do
 * catálogo na hora.**
 *
 * "Apagar a aula com o que está ligado" (decisão 7) não é uma lista de
 * tabelas escrita aqui: é o que `pg_constraint` diz que aponta para a aula,
 * e depois para o que aponta para isso, e assim por diante. Uma lista fixa
 * envelheceria no dia da próxima migration — e a AC-025 (i) cria uma tabela
 * de teste com FK nova justamente para reprovar lista fixa.
 *
 * ## As quatro regras, e de onde veio cada uma
 *
 * 1. **Desce só por aresta que tem linha.** Descer por tabela abortaria no
 *    schema de hoje: `movimentos_de_credito` se autorreferencia, e nenhuma
 *    aula `TURMA` chega lá (fato 17, a B1 da 2ª rodada).
 * 2. **Desce por TODA FK, qualquer que seja a ação**, `SET NULL` inclusive. A
 *    `fila_falta_fkey` é `SET NULL`, e o `fila_credito_chk` recusa a anulação
 *    numa fila ativa de aula — deixar a filha ficar com o vínculo anulado
 *    derrubaria a aula inteira com `23514` (fato 21, a N1).
 * 3. **Toda correspondência vira aresta**, mesmo quando a filha já foi vista;
 *    `visitados` só impede EXPANDIR de novo. Sem isso o ciclo de linhas não
 *    apareceria na ordenação (a R1).
 * 4. **Só ciclo de LINHAS aborta** — linha que se alcança a si mesma, e que
 *    por isso nunca chega a grau zero na ordenação dos filhos para os pais.
 *
 * **Identidade de linha:** a chave primária, serializada pelo PRÓPRIO banco
 * (`json_build_array(col::text, …)::text`). Nunca montada em JS: a mesma
 * expressão produz a chave quando o fecho acha a linha e quando o `DELETE`
 * a devolve, e é isso que torna as duas comparáveis.
 */

/** O mínimo de cliente que o fecho usa — um `PrismaClient` ou um `tx`. */
export interface ClienteDoFecho {
  $queryRawUnsafe<T = unknown>(sql: string, ...valores: unknown[]): Promise<T>;
}

/** A tabela de onde o fecho parte. */
export const TABELA_RAIZ = 'ocupacoes_quadra';

const ACOES: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

export interface ChaveEstrangeira {
  nome: string;
  filha: string;
  pai: string;
  colunasFilha: string[];
  colunasPai: string[];
  /** A ação de `DELETE`, por extenso. Descemos por todas (regra 2). */
  acao: string;
}

export interface Catalogo {
  fks: ChaveEstrangeira[];
  /** tabela → colunas da chave primária, na ordem do índice. */
  chaves: Map<string, string[]>;
}

/** Identificador entre aspas — nome vindo do catálogo, nunca do usuário. */
export const ident = (nome: string): string => `"${nome.replace(/"/g, '""')}"`;

/** A expressão da identidade de uma linha, sempre a mesma. */
export function exprDaChave(alias: string, colunas: readonly string[]): string {
  return `json_build_array(${colunas
    .map((c) => `${alias}.${ident(c)}::text`)
    .join(', ')})::text`;
}

export async function lerCatalogo(db: ClienteDoFecho): Promise<Catalogo> {
  const fks = await db.$queryRawUnsafe<
    (Omit<ChaveEstrangeira, 'acao'> & { acao: string })[]
  >(
    `SELECT c.conname::text AS nome,
            cf.relname::text AS filha,
            cp.relname::text AS pai,
            c.confdeltype::text AS acao,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
                   ORDER BY k.ord) AS "colunasFilha",
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
                   ORDER BY k.ord) AS "colunasPai"
       FROM pg_constraint c
       JOIN pg_class cf ON cf.oid = c.conrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       JOIN pg_class cp ON cp.oid = c.confrelid
       JOIN pg_namespace np ON np.oid = cp.relnamespace
      WHERE c.contype = 'f' AND nf.nspname = 'public' AND np.nspname = 'public'
      ORDER BY c.conname, cf.relname`,
  );
  const chaves = await db.$queryRawUnsafe<
    { tabela: string; colunas: string[] }[]
  >(
    `SELECT t.relname::text AS tabela,
            ARRAY(SELECT a.attname::text
                    FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.num
                   ORDER BY k.ord) AS colunas
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE i.indisprimary AND n.nspname = 'public'`,
  );
  return {
    fks: fks.map((f) => ({ ...f, acao: ACOES[f.acao] ?? f.acao })),
    chaves: new Map(chaves.map((c) => [c.tabela, c.colunas])),
  };
}

/**
 * As FKs que o fecho PODE alcançar a partir de `ocupacoes_quadra` — por
 * tabela, e não por linha. É o catálogo que entra na impressão do plano: uma
 * tabela nova com FK para a aula muda a impressão mesmo vazia (AC-033 iii).
 */
export function fksAlcancaveis(catalogo: Catalogo): ChaveEstrangeira[] {
  const tabelas = new Set([TABELA_RAIZ]);
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const fk of catalogo.fks) {
      if (tabelas.has(fk.pai) && !tabelas.has(fk.filha)) {
        tabelas.add(fk.filha);
        cresceu = true;
      }
    }
  }
  return catalogo.fks.filter((fk) => tabelas.has(fk.pai));
}

/** O texto canônico das FKs alcançáveis: nome, tabelas, colunas e ação. */
export function textoDoCatalogo(catalogo: Catalogo): string {
  return fksAlcancaveis(catalogo)
    .map(
      (fk) =>
        `${fk.nome}|${fk.filha}(${fk.colunasFilha.join(',')})|${fk.pai}(${fk.colunasPai.join(',')})|${fk.acao}`,
    )
    .sort()
    .join('\n');
}

export const sha256 = (texto: string): string =>
  createHash('sha256').update(texto, 'utf8').digest('hex');

/** Uma linha do fecho: `tabela` + chave serializada pelo banco. */
export interface Linha {
  tabela: string;
  chave: string;
}

export const noDe = (l: Linha): string => `${l.tabela}:${l.chave}`;

export interface Fecho {
  /** Toda linha alcançada, raízes inclusive, por nó (`tabela:chave`). */
  linhas: Map<string, Linha>;
  /** pai → filhas. Toda correspondência vira aresta (regra 3). */
  filhas: Map<string, Set<string>>;
}

export class SemChavePrimaria extends Error {
  constructor(readonly tabela: string) {
    super(`a tabela ${tabela} foi alcançada e não tem chave primária`);
  }
}

export class CicloDeLinhas extends Error {
  constructor(readonly linhas: string[]) {
    super(
      `ciclo de linhas: ${linhas.slice(0, 5).join(', ')}${linhas.length > 5 ? ', …' : ''}`,
    );
  }
}

function chaveDe(catalogo: Catalogo, tabela: string): string[] {
  const colunas = catalogo.chaves.get(tabela);
  if (!colunas || colunas.length === 0) throw new SemChavePrimaria(tabela);
  return colunas;
}

/**
 * O fecho de linhas a partir das aulas `raizes`, **no estado atual** do
 * banco, pela conexão recebida (dentro da transação de quem chama).
 */
export async function calcularFecho(
  db: ClienteDoFecho,
  catalogo: Catalogo,
  raizes: readonly string[],
): Promise<Fecho> {
  const linhas = new Map<string, Linha>();
  const filhas = new Map<string, Set<string>>();
  if (raizes.length === 0) return { linhas, filhas };

  const chaveDaRaiz = chaveDe(catalogo, TABELA_RAIZ);
  const iniciais = await db.$queryRawUnsafe<{ chave: string }[]>(
    `SELECT ${exprDaChave('x', chaveDaRaiz)} AS chave
       FROM ${ident(TABELA_RAIZ)} x
      WHERE x.id::text = ANY($1::text[])`,
    [...raizes],
  );

  // A fronteira é o que foi visitado e ainda não expandido, por tabela.
  let fronteira = new Map<string, string[]>();
  for (const { chave } of iniciais) {
    const l = { tabela: TABELA_RAIZ, chave };
    linhas.set(noDe(l), l);
    fronteira.set(TABELA_RAIZ, [...(fronteira.get(TABELA_RAIZ) ?? []), chave]);
  }

  const porPai = new Map<string, ChaveEstrangeira[]>();
  for (const fk of catalogo.fks) {
    porPai.set(fk.pai, [...(porPai.get(fk.pai) ?? []), fk]);
  }

  while (fronteira.size > 0) {
    const proxima = new Map<string, string[]>();
    for (const tabela of [...fronteira.keys()].sort()) {
      const chavesDoPai = fronteira.get(tabela) as string[];
      const colunasDoPai = chaveDe(catalogo, tabela);
      for (const fk of porPai.get(tabela) ?? []) {
        const juncao = fk.colunasFilha
          .map((c, i) => `f.${ident(c)} = p.${ident(fk.colunasPai[i])}`)
          .join(' AND ');
        const filtro = `${exprDaChave('p', colunasDoPai)} = ANY($1::text[])`;
        const colunasDaFilha = catalogo.chaves.get(fk.filha);
        if (!colunasDaFilha || colunasDaFilha.length === 0) {
          // Sem chave primária só aborta se houver linha a identificar.
          const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM ${ident(fk.filha)} f
               JOIN ${ident(tabela)} p ON ${juncao} WHERE ${filtro}`,
            chavesDoPai,
          );
          if (n > 0) throw new SemChavePrimaria(fk.filha);
          continue;
        }
        const pares = await db.$queryRawUnsafe<
          { pai: string; filha: string }[]
        >(
          `SELECT ${exprDaChave('p', colunasDoPai)} AS pai,
                  ${exprDaChave('f', colunasDaFilha)} AS filha
             FROM ${ident(fk.filha)} f
             JOIN ${ident(tabela)} p ON ${juncao}
            WHERE ${filtro}`,
          chavesDoPai,
        );
        for (const par of pares) {
          const pai = noDe({ tabela, chave: par.pai });
          const filha = { tabela: fk.filha, chave: par.filha };
          const noFilha = noDe(filha);
          const conjunto = filhas.get(pai) ?? new Set<string>();
          conjunto.add(noFilha);
          filhas.set(pai, conjunto);
          if (!linhas.has(noFilha)) {
            linhas.set(noFilha, filha);
            proxima.set(fk.filha, [
              ...(proxima.get(fk.filha) ?? []),
              par.filha,
            ]);
          }
        }
      }
    }
    fronteira = proxima;
  }
  return { linhas, filhas };
}

/**
 * A ordem de apagar: **dos filhos para os pais**, em camadas. Numa camada
 * nenhuma linha é pai de outra, e dentro dela o desempate é o nome da tabela
 * e depois a chave — a mesma ordem total em toda conferência (R13).
 *
 * Sobrou linha que nunca chegou a grau zero → ciclo de linhas (regra 4).
 */
export function camadasDeApagar(fecho: Fecho): Linha[][] {
  const pendentes = new Map<string, number>();
  const pais = new Map<string, string[]>();
  for (const no of fecho.linhas.keys()) pendentes.set(no, 0);
  for (const [pai, filhas] of fecho.filhas) {
    pendentes.set(pai, filhas.size);
    for (const filha of filhas) {
      pais.set(filha, [...(pais.get(filha) ?? []), pai]);
    }
  }

  const camadas: Linha[][] = [];
  let atual = [...pendentes].filter(([, n]) => n === 0).map(([no]) => no);
  let feitas = 0;
  while (atual.length > 0) {
    const camada = atual
      .map((no) => fecho.linhas.get(no) as Linha)
      .sort((a, b) =>
        a.tabela === b.tabela
          ? a.chave < b.chave
            ? -1
            : a.chave > b.chave
              ? 1
              : 0
          : a.tabela < b.tabela
            ? -1
            : 1,
      );
    camadas.push(camada);
    feitas += atual.length;
    const proxima: string[] = [];
    for (const no of atual) {
      for (const pai of pais.get(no) ?? []) {
        const n = (pendentes.get(pai) as number) - 1;
        pendentes.set(pai, n);
        if (n === 0) proxima.push(pai);
      }
    }
    atual = proxima;
  }
  if (feitas < fecho.linhas.size) {
    throw new CicloDeLinhas(
      [...pendentes]
        .filter(([, n]) => n > 0)
        .map(([no]) => no)
        .sort(),
    );
  }
  return camadas;
}

/** As linhas de uma camada agrupadas por tabela, na ordem da camada. */
export function porTabela(camada: readonly Linha[]): [string, string[]][] {
  const grupos = new Map<string, string[]>();
  for (const l of camada) {
    grupos.set(l.tabela, [...(grupos.get(l.tabela) ?? []), l.chave]);
  }
  return [...grupos];
}

/**
 * SPEC-069/TASK-001 — o alvo da acao, e as DUAS pernas da FK composta.
 *
 * ## O que este arquivo falseia
 *
 * A TASK-001 instala quatro mecanismos, e cada um so vale se houver um teste
 * que fique vermelho quando ele sair:
 *
 * | Mecanismo | Falseado por |
 * |---|---|
 * | `eventos_turma_append_only` (INV-069c) | AC-005 |
 * | FK composta `(company_id, turma_id)` (INV-069d) | AC-011 |
 * | FK composta `(company_id, acao_id)` (a outra perna da INV-069d) | a prova irma |
 * | os quatro indices (INV-069g) | a ultima prova, por `pg_indexes` |
 *
 * ## Por que a AC-011 nao basta sozinha
 *
 * A AC-011 prova a perna da TURMA: `company_id` de A com turma de B e
 * recusado. **Ela nao diz nada sobre a perna da ACAO** — um evento com o
 * `company_id` certo e a acao de outra empresa e tao cross-tenant quanto o
 * inverso, e passaria numa implementacao que tivesse deixado a segunda FK
 * simples. E a mesma familia do `IS NOT NULL` de carona da SPEC-068: declarar
 * duas protecoes e provar uma.
 *
 * Por isso as duas recusas **nomeiam a constraint**. Sem o nome, qualquer
 * `23503` — de qualquer FK, inclusive de uma errada — deixaria a prova verde.
 *
 * ## E por que ha um controle POSITIVO
 *
 * Um `INSERT` que falhasse por qualquer motivo tambem seria "recusado". O
 * primeiro caso grava o evento legitimo; sem ele, uma tabela quebrada passaria
 * em todas as recusas abaixo.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa, TABELAS_DA_EMPRESA } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

// A dona, e a vizinha que nunca pode ser alcancada.
const EMPRESA_A = 'f0690000-0000-4000-8000-000000000001';
const UADMIN_A = 'f0690000-0000-4000-8000-000000000002';
const ESPORTE_A = 'f0690000-0000-4000-8000-000000000003';
const QUADRA_A = 'f0690000-0000-4000-8000-000000000004';
const TURMA_A = 'f0690000-0000-4000-8000-000000000005';
const ACAO_A = 'f0690000-0000-4000-8000-000000000006';

const EMPRESA_B = 'f0690000-0000-4000-8000-0000000000b1';
const UADMIN_B = 'f0690000-0000-4000-8000-0000000000b2';
const ESPORTE_B = 'f0690000-0000-4000-8000-0000000000b3';
const QUADRA_B = 'f0690000-0000-4000-8000-0000000000b4';
const TURMA_B = 'f0690000-0000-4000-8000-0000000000b5';
const ACAO_B = 'f0690000-0000-4000-8000-0000000000b6';

const EVENTO = 'f0690000-0000-4000-8000-0000000000e1';

async function semearEmpresa(
  empresa: string,
  admin: string,
  esporte: string,
  quadra: string,
  turma: string,
  acao: string,
  slug: string,
) {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresa}','SPEC-069 ${slug}','${slug}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${admin}','${slug}@x.test','x','Admin','company_admin','${empresa}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${esporte}','${empresa}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadra}','${empresa}','Q1','${esporte}',100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${turma}','${empresa}','T1','${quadra}',20)`,
  );
  // A acao NUA — legitima hoje, e impossivel a partir do Deploy 2 (AC-003).
  // Aqui ela existe para ser o ALVO da FK, e nao o objeto do teste.
  await q(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id,criado_em)
     VALUES ('${acao}','${empresa}','turma_professor_alterado','${admin}',now())`,
  );
}

async function semear() {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await semearEmpresa(
    EMPRESA_A,
    UADMIN_A,
    ESPORTE_A,
    QUADRA_A,
    TURMA_A,
    ACAO_A,
    'spec-069-a',
  );
  await semearEmpresa(
    EMPRESA_B,
    UADMIN_B,
    ESPORTE_B,
    QUADRA_B,
    TURMA_B,
    ACAO_B,
    'spec-069-b',
  );
}

const inserirEvento = (
  id: string,
  empresa: string,
  acao: string,
  turma: string,
) =>
  q(
    `INSERT INTO eventos_de_turma (id,company_id,acao_id,turma_id,tipo)
     VALUES ('${id}','${empresa}','${acao}','${turma}','professor_alterado')`,
  );

const contaEventos = () =>
  db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM eventos_de_turma WHERE company_id = '${EMPRESA_A}'`,
  );

beforeEach(async () => {
  await semear();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('SPEC-069/TASK-001 — eventos_de_turma', () => {
  it('controle positivo: o evento legitimo grava, e e ele que da sentido as recusas', async () => {
    await expect(
      inserirEvento(EVENTO, EMPRESA_A, ACAO_A, TURMA_A),
    ).resolves.toBe(1);
    expect(Number((await contaEventos())[0].n)).toBe(1);
  });

  /**
   * AC-005 — append-only, pelo MESMO trigger dos cinco irmaos
   * (`append_only_com_valvula_de_teste`, SPEC-032/INV-061). As duas operacoes,
   * porque uma tabela que recusasse `DELETE` e aceitasse `UPDATE` reescreveria
   * o extrato sem deixar rastro — o oposto do que ela existe para fazer.
   */
  it('AC-005: UPDATE e DELETE sao recusados pelo append-only', async () => {
    await inserirEvento(EVENTO, EMPRESA_A, ACAO_A, TURMA_A);

    await expect(
      q(
        `UPDATE eventos_de_turma SET tipo = 'professor_alterado' WHERE id = '${EVENTO}'`,
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      q(`DELETE FROM eventos_de_turma WHERE id = '${EVENTO}'`),
    ).rejects.toThrow(/append-only/);

    // E a linha continua la: a recusa nao pode ter sido "deu erro depois de
    // apagar".
    expect(Number((await contaEventos())[0].n)).toBe(1);
  });

  /**
   * AC-011 — a prova de ESCRITA da INV-069d. A AC-008 provara a leitura (404
   * cross-empresa, pelo filtro do servico), e uma nao substitui a outra:
   * leitura e politica de aplicacao, isto aqui e o banco recusando.
   */
  it('AC-011: company_id de A com turma de B e recusado com 23503', async () => {
    await expect(
      inserirEvento(EVENTO, EMPRESA_A, ACAO_A, TURMA_B),
    ).rejects.toThrow(/23503/);
    await expect(
      inserirEvento(EVENTO, EMPRESA_A, ACAO_A, TURMA_B),
    ).rejects.toThrow(/eventos_turma_turma_fkey/);
    expect(Number((await contaEventos())[0].n)).toBe(0);
  });

  /**
   * A outra perna, que a AC-011 nao cobre. Sem ela, uma implementacao com a FK
   * da acao SIMPLES (so `acao_id`) passaria em tudo o que esta acima.
   */
  it('INV-069d: company_id de A com acao de B e recusado com 23503', async () => {
    await expect(
      inserirEvento(EVENTO, EMPRESA_A, ACAO_B, TURMA_A),
    ).rejects.toThrow(/23503/);
    await expect(
      inserirEvento(EVENTO, EMPRESA_A, ACAO_B, TURMA_A),
    ).rejects.toThrow(/eventos_turma_acao_fkey/);
    expect(Number((await contaEventos())[0].n)).toBe(0);
  });

  /**
   * O delta da TASK-001 ao write-set: a tabela tem `company_id`, entao entra
   * na limpeza — **na posicao certa** e **no conjunto `APPEND_ONLY`**, que sao
   * dois requisitos diferentes. `limpar-empresa-cobertura.db-spec.ts` cobre o
   * primeiro pela lista; so a execucao cobre o segundo.
   */
  it('a limpeza alcanca a tabela nova: ordem, valvula e ate o fim', async () => {
    const pos = (t: string) => TABELAS_DA_EMPRESA.indexOf(t as never);
    expect(pos('eventos_de_turma')).toBeGreaterThanOrEqual(0);
    expect(pos('eventos_de_turma')).toBeLessThan(pos('turmas'));
    expect(pos('eventos_de_turma')).toBeLessThan(pos('acoes_administrativas'));

    await inserirEvento(EVENTO, EMPRESA_A, ACAO_A, TURMA_A);
    expect(Number((await contaEventos())[0].n)).toBe(1);

    // O DELETE cru continua recusado (a valvula nao vazou para a sessao)...
    await expect(
      q(`DELETE FROM eventos_de_turma WHERE company_id = '${EMPRESA_A}'`),
    ).rejects.toThrow(/append-only/);

    // ...e a limpeza, que a abre dentro da propria transacao, vai ate o fim.
    await expect(limparEmpresa(db, EMPRESA_A)).resolves.toBeUndefined();
    expect(Number((await contaEventos())[0].n)).toBe(0);
  });

  /**
   * INV-069g — os indices por NOME e por DEFINICAO.
   *
   * Por definicao, e nao so por nome, porque o que o `acao_exige_alvo` do
   * Deploy 2 precisa e da ORDEM das colunas: `company_id` lidera os quatro
   * btrees, e um indice com o mesmo nome e as colunas trocadas nao serviria ao
   * `EXISTS`. A AC-013 medira o plano com 100 mil linhas; isto aqui e a
   * pre-condicao dela, e falha primeiro e mais barato.
   */
  it('INV-069g: os quatro indices existem, com as colunas na ordem certa', async () => {
    const esperados: Record<string, RegExp> = {
      eventos_turma_acao_idx:
        /eventos_de_turma USING btree \(company_id, acao_id\)/,
      eventos_matricula_acao_idx:
        /eventos_de_matricula USING btree \(company_id, acao_id\)/,
      movimentos_acao_idx:
        /movimentos_de_credito USING btree \(company_id, acao_id\)/,
      eventos_turma_idx:
        /eventos_de_turma USING btree \(company_id, turma_id, criado_em DESC\)/,
    };

    const nomes = Object.keys(esperados);
    const linhas = await db.$queryRawUnsafe<
      { indexname: string; indexdef: string }[]
    >(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (${nomes.map((n) => `'${n}'`).join(',')})`,
    );

    expect(linhas.map((l) => l.indexname).sort()).toEqual([...nomes].sort());
    for (const linha of linhas) {
      expect(linha.indexdef).toMatch(esperados[linha.indexname]);
    }
  });
});

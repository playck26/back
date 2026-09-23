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
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClassesService } from '../../src/classes/classes.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { CourtsService } from '../../src/courts/courts.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { comAcao } from './acao-com-efeito';
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

// TASK-002 — os dois professores da empresa A. A turma nasce com o primeiro,
// para que a troca tenha um "quem saiu" e exercite o caminho real da SPEC-068.
const UPROF1 = 'f0690000-0000-4000-8000-0000000000c1';
const PROF1 = 'f0690000-0000-4000-8000-0000000000c2';
const TURMA2_A = 'f0690000-0000-4000-8000-0000000000a2';
const TURMA2_B = 'f0690000-0000-4000-8000-0000000000b7';
const UPROF2 = 'f0690000-0000-4000-8000-0000000000c3';
const PROF2 = 'f0690000-0000-4000-8000-0000000000c4';

/**
 * O serviço de verdade, contra o banco de verdade. `CourtsService` e
 * `StudentsService` ficam de fora porque o caminho medido aqui não os alcança:
 * trocar só o professor não mexe na grade, então `precisaCancelar` é falso.
 */
const classes = new ClassesService(
  db as unknown as PrismaService,
  {} as unknown as CourtsService,
  {} as unknown as StudentsService,
  new ConfigOperacaoService(db as unknown as PrismaService),
);

async function semearEmpresa(
  empresa: string,
  admin: string,
  esporte: string,
  quadra: string,
  turma: string,
  turma2: string,
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
  // A SEGUNDA turma, que carrega o historico semeado. A do cenario precisa
  // ficar vazia: a AC-010 exige `200 []` em TURMA_A, e a AC-008 exige o mesmo
  // em TURMA_B pela empresa dela.
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${turma2}','${empresa}','T2','${quadra}',20)`,
  );

  // **A acao nasce COM efeito, e nao nua.** Ate a SPEC-069 ela podia nascer
  // sozinha; a partir do Deploy 2 o `acao_exige_alvo` recusa isso no COMMIT, e
  // uma fixture em autocommit morre com 23514 sem que nada do produto esteja
  // errado. Aqui ela existe para ser o ALVO da FK dos casos abaixo — e o
  // efeito dela mora na turma 2, nao na do cenario.
  await comAcao(
    db,
    {
      id: acao,
      companyId: empresa,
      tipo: 'turma_professor_alterado',
      autorId: admin,
    },
    (tx, acaoId) =>
      tx.$executeRawUnsafe(
        `INSERT INTO eventos_de_turma (id,company_id,acao_id,turma_id,tipo)
         VALUES (gen_random_uuid(),'${empresa}','${acaoId}','${turma2}','professor_alterado')`,
      ),
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
    TURMA2_A,
    ACAO_A,
    'spec-069-a',
  );
  await semearEmpresa(
    EMPRESA_B,
    UADMIN_B,
    ESPORTE_B,
    QUADRA_B,
    TURMA_B,
    TURMA2_B,
    ACAO_B,
    'spec-069-b',
  );
  await semearProfessoresDeA();
}

async function semearProfessoresDeA() {
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${UPROF1}','spec-069-p1@x.test','x','Professor Um','professor','${EMPRESA_A}',now()),
       ('${UPROF2}','spec-069-p2@x.test','x','Professor Dois','professor','${EMPRESA_A}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES
       ('${PROF1}','${EMPRESA_A}','Professor Um','${UPROF1}',now()),
       ('${PROF2}','${EMPRESA_A}','Professor Dois','${UPROF2}',now())`,
  );
  await q(
    `UPDATE turmas SET professor_id = '${PROF1}' WHERE id = '${TURMA_A}'`,
  );
}

/** As linhas de `eventos_de_turma` da turma A, com o tipo da ação junto. */
const eventosDaTurma = () =>
  db.$queryRawUnsafe<{ tipo: string; acao_tipo: string; turma_id: string }[]>(
    `SELECT e.tipo, a.tipo AS acao_tipo, e.turma_id
       FROM eventos_de_turma e
       JOIN acoes_administrativas a
         ON a.company_id = e.company_id AND a.id = e.acao_id
      WHERE e.company_id = '${EMPRESA_A}' AND e.turma_id = '${TURMA_A}'`,
  );

const contaAcoes = async () =>
  Number(
    (
      await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM acoes_administrativas WHERE company_id = '${EMPRESA_A}'`,
      )
    )[0].n,
  );

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

/**
 * As linhas da turma A — **por turma, e nao por empresa**. A empresa A tem uma
 * segunda turma com historico proprio (ver `semearProfessoresDeA`), e um
 * contador por empresa faria estes casos medirem o vizinho.
 */
const contaEventos = () =>
  db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM eventos_de_turma
      WHERE company_id = '${EMPRESA_A}' AND turma_id = '${TURMA_A}'`,
  );

/** A empresa inteira — o que a limpeza tem de zerar. */
const contaEventosDaEmpresa = () =>
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
    // Duas: a desta turma e a da turma vizinha, semeada. A limpeza tem de
    // zerar a EMPRESA, nao a turma do caso.
    expect(Number((await contaEventosDaEmpresa())[0].n)).toBe(2);

    // O DELETE cru continua recusado (a valvula nao vazou para a sessao)...
    await expect(
      q(`DELETE FROM eventos_de_turma WHERE company_id = '${EMPRESA_A}'`),
    ).rejects.toThrow(/append-only/);

    // ...e a limpeza, que a abre dentro da propria transacao, vai ate o fim.
    await expect(limparEmpresa(db, EMPRESA_A)).resolves.toBeUndefined();
    expect(Number((await contaEventosDaEmpresa())[0].n)).toBe(0);
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

/**
 * SPEC-069/TASK-002 — **o gesto passa a dizer QUAL turma.**
 *
 * Até a SPEC-068, trocar o professor não deixava rastro nenhum; ela criou a
 * ação e, com ela, o estado "ação sem alvo". Aqui a ação nasce **com** a linha
 * de `eventos_de_turma`, na mesma transação.
 *
 * ## Por que o serviço, e não a rota
 *
 * A AC-002 fala em **200**, e o que ela está comprando com isso é a
 * discriminação: *um `PATCH` que falhasse com 500 também daria delta zero*.
 * Chamado pelo serviço, o equivalente honesto é **a chamada resolver e
 * devolver a turma atualizada** — e é isso que os dois casos afirmam, além do
 * delta. É a mesma escolha do `fit-049`, que mede esse mesmo gesto.
 */
describe('SPEC-069/TASK-002 — a troca de professor grava o evento', () => {
  it('AC-001: a troca grava UMA linha, e a acao ligada a ela e do tipo certo', async () => {
    const acoesAntes = await contaAcoes();

    await classes.update(EMPRESA_A, TURMA_A, { professorId: PROF2 }, UADMIN_A);

    const eventos = await eventosDaTurma();
    expect(eventos).toHaveLength(1);
    expect(eventos[0].tipo).toBe('professor_alterado');
    expect(eventos[0].turma_id).toBe(TURMA_A);
    // **As duas pontas.** So o nome do evento nao prova a ligacao: a acao
    // ligada a ele tem de ser a do gesto, e nao uma qualquer.
    expect(eventos[0].acao_tipo).toBe('turma_professor_alterado');
    expect(await contaAcoes()).toBe(acoesAntes + 1);
  });

  it('AC-002: o PATCH que NAO troca o professor resolve, e o delta e ZERO nas duas tabelas', async () => {
    // Controle positivo primeiro: sem ele, "delta zero" ficaria verde num
    // caminho que nunca grava nada.
    await classes.update(EMPRESA_A, TURMA_A, { professorId: PROF2 }, UADMIN_A);
    expect(await eventosDaTurma()).toHaveLength(1);

    const eventosAntes = (await eventosDaTurma()).length;
    const acoesAntes = await contaAcoes();

    // (a) sem `professorId` no corpo — renomear nao e gesto de professor.
    const renomeada = await classes.update(
      EMPRESA_A,
      TURMA_A,
      { nome: 'T1 renomeada' },
      UADMIN_A,
    );
    expect(renomeada.nome).toBe('T1 renomeada');

    // (b) com o MESMO `professorId` — retentativa de rede, nao gesto. Este e
    // o caso que separa "trocou" de "mandou o formulario de novo", e ele so
    // existe porque a comparacao acontece sob o `FOR UPDATE` (SPEC-068/D6).
    const mesma = await classes.update(
      EMPRESA_A,
      TURMA_A,
      { professorId: PROF2 },
      UADMIN_A,
    );
    expect(mesma.professorId).toBe(PROF2);

    expect((await eventosDaTurma()).length).toBe(eventosAntes);
    expect(await contaAcoes()).toBe(acoesAntes);
  });

  /**
   * **A pergunta do 5o gate, feita antes da sabotagem:** o que passa na AC-001
   * e ainda assim quebra?
   *
   * Uma acao gravada FORA da transacao do gesto. As duas linhas existiriam, a
   * AC-001 ficaria verde — e, a partir do Deploy 2, o `acao_exige_alvo` mataria
   * o `PATCH` em producao com `23514` no `COMMIT`, porque a acao commitaria
   * sozinha, antes de o evento existir.
   *
   * O molde e o da AC-016 da SPEC-068: um gatilho de teste derruba a transacao
   * DEPOIS do gesto — o despacho dos avisos vem logo a seguir, no mesmo bloco —
   * e o que se mede e o residuo. Com `tx`, nao sobra nada.
   */
  it('a acao e o evento nascem na MESMA transacao do gesto: erro depois deles nao deixa residuo', async () => {
    const acoesAntes = await contaAcoes();
    await q(
      `CREATE FUNCTION falha_proposital_069() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'falha proposital da SPEC-069'; END $$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER falha_proposital_069 BEFORE INSERT ON notificacoes
         FOR EACH ROW EXECUTE FUNCTION falha_proposital_069()`,
    );
    try {
      await expect(
        classes.update(EMPRESA_A, TURMA_A, { professorId: PROF2 }, UADMIN_A),
      ).rejects.toThrow(/falha proposital da SPEC-069/);

      expect(await eventosDaTurma()).toHaveLength(0);
      expect(await contaAcoes()).toBe(acoesAntes);
    } finally {
      await q(`DROP TRIGGER falha_proposital_069 ON notificacoes`);
      await q(`DROP FUNCTION falha_proposital_069()`);
    }
  });
});

/**
 * SPEC-069/TASK-003 — **o extrato da turma, lido pelo serviço de verdade.**
 *
 * O que fica aqui e o que fica na e2e, e por quê: o **403** é do
 * `CompanyAdminGuard`, que só existe com a pilha HTTP em pé — ele está em
 * `test/classes-eventos.e2e-spec.ts`. O **404**, a **ordem** e o **`200 []`**
 * são do serviço, e provar isso com um dublê provaria o dublê.
 */
describe('SPEC-069/TASK-003 — o extrato da turma', () => {
  it('AC-006: os campos e a ORDEM sao contrato — mais novo primeiro', async () => {
    // Dois gestos, para que exista ordem a conferir. Um evento só ficaria
    // verde com `orderBy` nenhum, ou com `asc`.
    await classes.update(EMPRESA_A, TURMA_A, { professorId: PROF2 }, UADMIN_A);
    await classes.update(EMPRESA_A, TURMA_A, { professorId: PROF1 }, UADMIN_A);

    const extrato = await classes.eventosDaTurma(EMPRESA_A, TURMA_A);

    expect(extrato).toHaveLength(2);
    expect(Object.keys(extrato[0]).sort()).toEqual([
      'acao',
      'autor',
      'em',
      'motivo',
      'tipo',
    ]);
    expect(extrato[0]).toMatchObject({
      tipo: 'professor_alterado',
      acao: 'turma_professor_alterado',
      motivo: null,
      autor: { id: UADMIN_A, nome: 'Admin' },
    });
    // `em` e string ISO, nao Date: quem le e um cliente HTTP.
    expect(typeof extrato[0].em).toBe('string');
    expect(new Date(extrato[0].em).getTime()).toBeGreaterThanOrEqual(
      new Date(extrato[1].em).getTime(),
    );
  });

  it('AC-010: turma que existe e nao tem historico devolve 200 []', async () => {
    // Sem nenhum gesto. **Esta AC e a que impede o atalho**: um
    // `if (eventos.length === 0) throw NotFound` passaria na AC-006, na
    // AC-007 e na AC-008, e so aqui ficaria vermelho.
    await expect(classes.eventosDaTurma(EMPRESA_A, TURMA_A)).resolves.toEqual(
      [],
    );
  });

  it('AC-008: turma de OUTRA empresa devolve 404, e a origem e o filtro do servico', async () => {
    // A turma existe — e o gestor de A nao pode saber disso. A recusa nao vem
    // do guard: o `CompanyAdminGuard` confere papel e declaradamente nao faz
    // escopo de tenant. Vem do `{ id, companyId }` deste `findFirst`.
    await expect(classes.eventosDaTurma(EMPRESA_A, TURMA_B)).rejects.toThrow(
      NotFoundException,
    );

    // E o controle: da empresa dela, a MESMA turma responde.
    await expect(classes.eventosDaTurma(EMPRESA_B, TURMA_B)).resolves.toEqual(
      [],
    );
  });

  it('turma inexistente devolve 404 — e e a outra metade da D2', async () => {
    await expect(
      classes.eventosDaTurma(EMPRESA_A, '00000000-0000-4000-8000-000000000999'),
    ).rejects.toThrow(NotFoundException);
  });

  /**
   * **A pergunta do 5o gate para esta task:** o que passa nas quatro ACs e
   * ainda assim quebra?
   *
   * **Tirar o `turmaId` do `where`.** A AC-006 continuaria verde (so a turma
   * do cenario tem evento), a AC-010 tambem (nenhuma turma tem), e a AC-008 e
   * a AC-007 nem olham para o conteudo. O gestor abriria a turma A e veria o
   * historico da B — mesma empresa, turma errada, e nenhuma AC reclamando.
   *
   * Por isso existe uma SEGUNDA turma da mesma empresa, com evento proprio.
   */
  it('o extrato e DESTA turma, e nao o da empresa', async () => {
    await classes.update(EMPRESA_A, TURMA_A, { professorId: PROF2 }, UADMIN_A);

    const daPrimeira = await classes.eventosDaTurma(EMPRESA_A, TURMA_A);
    const daSegunda = await classes.eventosDaTurma(EMPRESA_A, TURMA2_A);

    // Uma linha cada, e a semeada na segunda nunca aparece na primeira.
    expect(daPrimeira).toHaveLength(1);
    expect(daSegunda).toHaveLength(1);
    // O controle que torna o caso nao-vacuo: as duas turmas TEM historico, e
    // a empresa toda tem duas linhas. Se o `where` fosse so por empresa, os
    // dois extratos teriam 2.
    const total = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM eventos_de_turma WHERE company_id = '${EMPRESA_A}'`,
    );
    expect(Number(total[0].n)).toBe(2);
  });
});

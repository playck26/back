/**
 * SPEC-064/TASK-001 — **a fila de espera contra o banco de verdade.**
 *
 * Nada do que esta em julgamento aqui existe em codigo TypeScript. Sao dois
 * CHECK, quatro indices unicos parciais e quatro FKs compostas — e um mock nao
 * tem constraint. Um teste de servico provaria no maximo que o servico faz o
 * que o servico faz, que e justamente o que NAO esta em julgamento: o que esta
 * e que um `INSERT` cru, escrito por alguem que ignorou todos os servicos, seja
 * recusado. Por isso cada prova aqui e SQL direto. (Mesmo molde do FIT-014 e do
 * FIT-021.)
 *
 * ## Por que o primeiro caso le `pg_constraint`
 *
 * **A DoR desta spec custou tres rodadas de validacao independente, e as duas
 * primeiras REPROVARAM por causa de UMA linha** — a acao referencial da FK do
 * credito. A historia, em ordem:
 *
 *   1. a v2 escrevia `ON DELETE SET NULL` sem lista de colunas. O PostgreSQL
 *      anula TODAS as colunas da FK, inclusive `company_id` e `aluno_id`, que
 *      sao `NOT NULL` — o `DELETE` da falta morria com **23502**. O mecanismo
 *      escolhido para garantir a invariante fazia o oposto dela;
 *   2. a v3 corrigiu para `SET NULL (falta_id)` — e **a correcao criou um
 *      bloqueio novo**: o `CHECK` e avaliado NO ATO do SET NULL, antes de o
 *      encerramento chegar, entao `DELETE -> UPDATE` morria com **23514**;
 *   3. a v4 tornou a ORDEM normativa. Adiar o CHECK nao era opcao: o
 *      PostgreSQL recusa `CHECK ... DEFERRABLE` em qualquer versao.
 *
 * Um teste que so insere e apaga passaria verde com QUALQUER uma das tres. Por
 * isso o primeiro caso le a acao referencial do catalogo e exige que ela nomeie
 * **exatamente `falta_id`**: e a unica prova que fica vermelha no dia em que
 * alguem "simplificar" a FK. Mesma familia do gate que confere o color type do
 * PNG do badge na SPEC-063 — **o artefato entregue, nao a intencao do autor.**
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA_A = '064f0640-0000-4000-8000-00000000000a';
const EMPRESA_B = '064f0640-0000-4000-8000-00000000000b';
const QUADRA_A = '064f0640-0000-4000-8000-00000000001a';
const QUADRA_B = '064f0640-0000-4000-8000-00000000001b';
const USUARIO_A = '064f0640-0000-4000-8000-00000000002a';
const USUARIO_A2 = '064f0640-0000-4000-8000-00000000002c';
const USUARIO_B = '064f0640-0000-4000-8000-00000000002b';
const ALUNO_A = '064f0640-0000-4000-8000-00000000003a';
/** Segundo aluno da MESMA empresa: e com ele que a AC-011 tem graca. */
const ALUNO_A2 = '064f0640-0000-4000-8000-00000000003c';
const ALUNO_B = '064f0640-0000-4000-8000-00000000003b';
const TURMA_A = '064f0640-0000-4000-8000-00000000004a';
const TURMA_B = '064f0640-0000-4000-8000-00000000004b';
/**
 * Turma da empresa A **sem ocorrencia nenhuma**, e existe por um vermelho:
 * o `DELETE FROM turmas` da TURMA_A batia primeiro em
 * `ocupacoes_quadra_origem_turma_fkey` (23001) e nunca chegava na FK que
 * estava em julgamento. **Teria passado verde pelo motivo errado** se o
 * `recusa` nao exigisse o identificador — que e exatamente por que ele
 * exige, e a mesma pedra em que FIT-014 e FIT-021 ja tropecaram.
 */
const TURMA_A_LIVRE = '064f0640-0000-4000-8000-00000000004c';
const OCUPACAO_A = '064f0640-0000-4000-8000-00000000005a';
const OCUPACAO_B = '064f0640-0000-4000-8000-00000000005b';
/** Falta do ALUNO_A. */
const FALTA_A = '064f0640-0000-4000-8000-00000000006a';
/** Falta do ALUNO_A2, na mesma ocorrencia — o credito "de outro aluno". */
const FALTA_A2 = '064f0640-0000-4000-8000-00000000006c';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const ler = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

/**
 * O texto completo do erro, message E meta — o SQLSTATE do Prisma vive em
 * `meta.code` nas consultas cruas, nao na mensagem.
 */
function textoDoErro(erro: unknown): string {
  const e = erro as { message?: string; meta?: unknown };
  return `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
}

/**
 * **Recusado, com o SQLSTATE certo E pela constraint certa.**
 *
 * As duas exigencias, e nao uma. A licao e herdada do FIT-014, cuja primeira
 * versao passou verde pelo motivo errado (o `INSERT` morria num enum antes de
 * chegar perto da chave). Aqui ela vale em dobro: **23514 e 23502 sao erros
 * diferentes com a mesma aparencia** — `rejects.toThrow()` nao distingue o
 * bloqueio 1 do bloqueio 2 desta spec, e foram eles que custaram as rodadas.
 *
 * **`identificador` nao e sempre o nome da constraint, e isso e do Prisma.**
 * Para FK (23503) e CHECK (23514) a mensagem traz o nome; para UNIQUE (23505)
 * ela traz `Key (colunas)=(valores) already exists` e **nao traz o nome do
 * indice**. Medido na primeira rodada deste arquivo, com dois casos vermelhos.
 * Entao nos dois casos de 23505 o identificador e a LISTA DE COLUNAS da chave —
 * que discrimina igualmente bem: `(turma_id)` so pode ser
 * `fila_chamado_turma_key`, e `(company_id, aluno_id, turma_id)` so pode ser
 * `fila_ativa_turma_key`.
 */
async function recusa(
  sql: string,
  sqlstate: string,
  identificador: string,
): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  const texto = textoDoErro(erro);
  expect(texto).toContain(sqlstate);
  expect(texto).toContain(identificador);
}

const filaTurma = (opcoes: {
  id: string;
  empresa: string;
  aluno: string;
  turma: string;
  estado?: string;
}) =>
  `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,estado)
   VALUES ('${opcoes.id}','${opcoes.empresa}','${opcoes.aluno}','${opcoes.turma}','${opcoes.estado ?? 'aguardando'}')`;

const filaAula = (opcoes: {
  id: string;
  empresa: string;
  aluno: string;
  ocupacao: string;
  falta: string | null;
  estado?: string;
}) =>
  `INSERT INTO lista_de_espera (id,company_id,aluno_id,ocupacao_id,falta_id,estado)
   VALUES ('${opcoes.id}','${opcoes.empresa}','${opcoes.aluno}','${opcoes.ocupacao}',${
     opcoes.falta ? `'${opcoes.falta}'` : 'NULL'
   },'${opcoes.estado ?? 'aguardando'}')`;

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA_A, 'A'],
    [EMPRESA_B, 'B'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-064 ${nome}','spec-064-${nome.toLowerCase()}-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
  }
  for (const [quadra, emp] of [
    [QUADRA_A, EMPRESA_A],
    [QUADRA_B, EMPRESA_B],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80)`,
    );
  }
  for (const [usuario, aluno, emp, sufixo] of [
    [USUARIO_A, ALUNO_A, EMPRESA_A, 'a'],
    [USUARIO_A2, ALUNO_A2, EMPRESA_A, 'a2'],
    [USUARIO_B, ALUNO_B, EMPRESA_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuario}','spec064-${sufixo}@teste.local','x','U','aluno','${emp}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${aluno}','${usuario}','${emp}','aprovado')`,
    );
  }
  for (const [turma, quadra, emp] of [
    [TURMA_A, QUADRA_A, EMPRESA_A],
    [TURMA_A_LIVRE, QUADRA_A, EMPRESA_A],
    [TURMA_B, QUADRA_B, EMPRESA_B],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${turma}','${emp}','T','${quadra}',4,'ativa')`,
    );
  }
  for (const [ocupacao, quadra, turma, emp] of [
    [OCUPACAO_A, QUADRA_A, TURMA_A, EMPRESA_A],
    [OCUPACAO_B, QUADRA_B, TURMA_B, EMPRESA_B],
  ] as const) {
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES ('${ocupacao}','${emp}','${quadra}',CURRENT_DATE + 3,'09:00','10:00','TURMA','${turma}','pendente_pagamento',now())`,
    );
  }
  // Duas faltas na MESMA ocorrencia, uma por aluno. `faltas_unica` e
  // `(ocupacao_id, aluno_id)`, entao as duas cabem.
  for (const [falta, aluno] of [
    [FALTA_A, ALUNO_A],
    [FALTA_A2, ALUNO_A2],
  ] as const) {
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,origem_tipo,aluno_id,updated_at) VALUES ('${falta}','${EMPRESA_A}','${OCUPACAO_A}','TURMA','${aluno}',now())`,
    );
  }
}

/** A fila inteira das duas empresas, entre um caso e outro. Os indices
 *  parciais sao por ALVO, e um caso deixaria o proximo impossivel. */
async function limparFila(): Promise<void> {
  await q(
    `DELETE FROM lista_de_espera WHERE company_id IN ('${EMPRESA_A}','${EMPRESA_B}')`,
  );
}

beforeAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await montar();
});

beforeEach(limparFila);

afterAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

describe('SPEC-064/TASK-001 — a fila, como o banco a garante', () => {
  // ========================================================================
  // O artefato entregue
  // ========================================================================

  it('INV-064g/1 — a FK do credito anula SOMENTE `falta_id`', async () => {
    const [fk] = await ler<{ acao: string; colunas: string | null }>(
      `SELECT c.confdeltype::text AS acao,
              (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                 FROM pg_attribute a
                WHERE a.attrelid = c.conrelid
                  AND a.attnum = ANY(c.confdelsetcols)) AS colunas
         FROM pg_constraint c
        WHERE c.conname = 'fila_falta_fkey' AND c.contype = 'f'`,
    );

    expect(fk).toBeDefined();
    // 'n' = SET NULL. 'a' seria NO ACTION (o que o Prisma geraria), 'r'
    // RESTRICT, 'c' CASCADE — e cada um deles quebraria a INV-064g de um
    // jeito diferente.
    expect(fk.acao).toBe('n');
    // **A lista, e so ela.** `company_id,aluno_id,falta_id` aqui significaria
    // SET NULL sem lista — o 23502 do primeiro bloqueio. `null` tambem.
    expect(fk.colunas).toBe('falta_id');
  });

  it('INV-064a/b — os quatro indices sao UNICOS e PARCIAIS', async () => {
    const indices = await ler<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'lista_de_espera' ORDER BY indexname`,
    );
    const porNome = new Map(indices.map((i) => [i.indexname, i.indexdef]));

    for (const nome of [
      'fila_ativa_turma_key',
      'fila_ativa_ocupacao_key',
      'fila_chamado_turma_key',
      'fila_chamado_ocupacao_key',
    ]) {
      const def = porNome.get(nome);
      expect(def).toBeDefined();
      expect(def).toContain('CREATE UNIQUE INDEX');
      // **Sem o `WHERE`, uma passagem pela fila proibiria a segunda para
      // sempre** — quem saiu ou ja foi atendido nunca mais entraria.
      expect(def).toContain('WHERE');
    }
  });

  // ========================================================================
  // INV-064c — fila de turma OU de aula
  // ========================================================================

  it('INV-064c — fila sem alvo nenhum e recusada', async () => {
    await recusa(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id) VALUES (gen_random_uuid(),'${EMPRESA_A}','${ALUNO_A}')`,
      '23514',
      'fila_um_alvo_chk',
    );
  });

  it('INV-064c — fila com os DOIS alvos e recusada', async () => {
    await recusa(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id)
       VALUES (gen_random_uuid(),'${EMPRESA_A}','${ALUNO_A}','${TURMA_A}','${OCUPACAO_A}','${FALTA_A}')`,
      '23514',
      'fila_um_alvo_chk',
    );
  });

  // ========================================================================
  // INV-064d — fila de aula ativa tem credito
  // ========================================================================

  it('INV-064d — fila de AULA sem credito e recusada enquanto ativa', async () => {
    for (const estado of ['aguardando', 'chamado']) {
      await recusa(
        filaAula({
          id: '064f0640-0000-4000-8000-0000000000e1',
          empresa: EMPRESA_A,
          aluno: ALUNO_A,
          ocupacao: OCUPACAO_A,
          falta: null,
          estado,
        }),
        '23514',
        'fila_credito_chk',
      );
    }
  });

  it('INV-064d — encerrada SEM credito passa: e a folga que a INV-064g usa', async () => {
    await expect(
      q(
        filaAula({
          id: '064f0640-0000-4000-8000-0000000000e2',
          empresa: EMPRESA_A,
          aluno: ALUNO_A,
          ocupacao: OCUPACAO_A,
          falta: null,
          estado: 'encerrada',
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('INV-064d — fila de TURMA nunca precisa de credito', async () => {
    await expect(
      q(
        filaTurma({
          id: '064f0640-0000-4000-8000-0000000000e3',
          empresa: EMPRESA_A,
          aluno: ALUNO_A,
          turma: TURMA_A,
        }),
      ),
    ).resolves.toBeDefined();
  });

  // ========================================================================
  // INV-064b — uma inscricao ativa por aluno e alvo (AC-001)
  // ========================================================================

  it('AC-001 — entrar duas vezes na mesma fila da mesma turma da 23505', async () => {
    await q(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000b1',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_A,
      }),
    );
    await recusa(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000b2',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_A,
      }),
      '23505',
      // `fila_ativa_turma_key` — o Prisma nao devolve o nome; a lista de
      // colunas da chave identifica o mesmo indice.
      'Key (company_id, aluno_id, turma_id)=',
    );
  });

  it('INV-064b — depois de DESISTIR, da para entrar de novo', async () => {
    await q(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000b3',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_A,
        estado: 'desistiu',
      }),
    );
    // **E isto que o `WHERE` do indice compra.** Sem ele, uma passagem pela
    // fila valeria como proibicao permanente.
    await expect(
      q(
        filaTurma({
          id: '064f0640-0000-4000-8000-0000000000b4',
          empresa: EMPRESA_A,
          aluno: ALUNO_A,
          turma: TURMA_A,
        }),
      ),
    ).resolves.toBeDefined();
  });

  // ========================================================================
  // INV-064a — um chamado por alvo (AC-003)
  // ========================================================================

  it('AC-003 — dois `chamado` na MESMA turma dao 23505, mesmo com alunos diferentes', async () => {
    await q(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000a1',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_A,
        estado: 'chamado',
      }),
    );
    // **E esta constraint que permite ao varredor (D8) dispensar advisory
    // lock:** dois ciclos simultaneos disputam o indice, e um perde.
    await recusa(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000a2',
        empresa: EMPRESA_A,
        aluno: ALUNO_A2,
        turma: TURMA_A,
        estado: 'chamado',
      }),
      '23505',
      // `fila_chamado_turma_key` — turma_id SOZINHO na chave e o que
      // distingue o indice do chamado do indice da inscricao ativa.
      'Key (turma_id)=',
    );
  });

  // ========================================================================
  // INV-064e / INV-064f — o credito e a empresa
  // ========================================================================

  it('AC-011 — credito de OUTRO ALUNO da mesma empresa e recusado', async () => {
    // O caso que a FK simples `(company_id, falta_id)` deixaria passar: mesma
    // empresa, mesma ocorrencia, dono diferente.
    await recusa(
      filaAula({
        id: '064f0640-0000-4000-8000-0000000000c1',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        ocupacao: OCUPACAO_A,
        falta: FALTA_A2,
      }),
      '23503',
      'fila_falta_fkey',
    );
    // O mesmo INSERT com o credito do proprio aluno TEM de passar — senao a
    // prova acima estaria verde por a linha ser invalida por outro motivo.
    await expect(
      q(
        filaAula({
          id: '064f0640-0000-4000-8000-0000000000c2',
          empresa: EMPRESA_A,
          aluno: ALUNO_A,
          ocupacao: OCUPACAO_A,
          falta: FALTA_A,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('INV-064f — aluno, turma e ocupacao de outra empresa sao recusados', async () => {
    await recusa(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000d1',
        empresa: EMPRESA_A,
        aluno: ALUNO_B,
        turma: TURMA_A,
      }),
      '23503',
      'fila_aluno_fkey',
    );
    await recusa(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000d2',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_B,
      }),
      '23503',
      'fila_turma_fkey',
    );
    await recusa(
      filaAula({
        id: '064f0640-0000-4000-8000-0000000000d3',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        ocupacao: OCUPACAO_B,
        falta: FALTA_A,
      }),
      '23503',
      'fila_ocupacao_fkey',
    );
  });

  // ========================================================================
  // INV-064g — as duas metades, e a ordem
  // ========================================================================

  it('INV-064g/2 — apagar a falta ANTES de encerrar morre com 23514', async () => {
    await q(
      filaAula({
        id: '064f0640-0000-4000-8000-0000000000f1',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        ocupacao: OCUPACAO_A,
        falta: FALTA_A,
      }),
    );
    // **Este e o bloqueio que a correcao do bloqueio 1 criou.** O CHECK e
    // avaliado NO ATO do SET NULL: a linha fica com `falta_id` nulo e estado
    // ainda `aguardando`, e `fila_credito_chk` morde antes de qualquer UPDATE
    // de encerramento poder existir.
    await recusa(
      `DELETE FROM faltas_avisadas WHERE id = '${FALTA_A}'`,
      '23514',
      'fila_credito_chk',
    );
  });

  it('AC-009/AC-012 — encerrar e DEPOIS apagar passa, e so `falta_id` vira nulo', async () => {
    const ID = '064f0640-0000-4000-8000-0000000000f2';
    await q(
      filaAula({
        id: ID,
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        ocupacao: OCUPACAO_A,
        falta: FALTA_A,
      }),
    );

    // A ordem normativa da D2/2, na mesma transacao: encerrar, depois apagar.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE lista_de_espera SET estado='encerrada', concluida_em=now(),
                motivo_fim='falta retirada' WHERE id='${ID}'`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM faltas_avisadas WHERE id = '${FALTA_A}'`,
      );
    });

    // **As QUATRO colunas, e nao tres.** As tres primeiras provam a metade da
    // FK (o SET NULL nomeado); a quarta prova que a prova nao depende da
    // AC-009 para significar alguma coisa.
    const [linha] = await ler<{
      company_id: string | null;
      aluno_id: string | null;
      falta_id: string | null;
      estado: string;
    }>(
      `SELECT company_id, aluno_id, falta_id, estado::text AS estado
         FROM lista_de_espera WHERE id='${ID}'`,
    );
    expect(linha.company_id).toBe(EMPRESA_A);
    expect(linha.aluno_id).toBe(ALUNO_A);
    expect(linha.falta_id).toBeNull();
    expect(linha.estado).toBe('encerrada');

    // A falta volta, para os outros casos e para a limpeza.
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,origem_tipo,aluno_id,updated_at) VALUES ('${FALTA_A}','${EMPRESA_A}','${OCUPACAO_A}','TURMA','${ALUNO_A}',now())`,
    );
  });

  it('INV-064g — sem fila ativa, apagar a falta nunca foi problema', async () => {
    // O caso comum: ninguem na fila. O `UPDATE` da TASK-004 nao acha nada e o
    // `DELETE` segue — a ordem continua correta quando nao ha o que ordenar.
    await expect(
      q(`DELETE FROM faltas_avisadas WHERE id = '${FALTA_A2}'`),
    ).resolves.toBeDefined();
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,origem_tipo,aluno_id,updated_at) VALUES ('${FALTA_A2}','${EMPRESA_A}','${OCUPACAO_A}','TURMA','${ALUNO_A2}',now())`,
    );
  });

  // ========================================================================
  // As FKs de escopo sao RESTRICT, e isso e escolha
  // ========================================================================

  it('as tres FKs de alvo sao RESTRICT: apagar turma com fila viva e erro', async () => {
    await q(
      filaTurma({
        id: '064f0640-0000-4000-8000-0000000000aa',
        empresa: EMPRESA_A,
        aluno: ALUNO_A,
        turma: TURMA_A_LIVRE,
      }),
    );
    // Nao e limpeza silenciosa: quem precisa encerrar fila passa pela
    // TASK-004, que escreve `motivo_fim`. Fila que some sem motivo e fila que
    // ninguem consegue auditar depois.
    //
    // **23001, e nao 23503**: RESTRICT violado no pai devolve
    // `restrict_violation`; o 23503 e do INSERT que aponta para o que nao
    // existe. Sao os dois lados da mesma FK, com codigos diferentes.
    await recusa(
      `DELETE FROM turmas WHERE id = '${TURMA_A_LIVRE}'`,
      '23001',
      'fila_turma_fkey',
    );
  });
});

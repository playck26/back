/**
 * SPEC-069/AC-013 — **o trigger não paga varredura.**
 *
 * ## Por que é prova de rodada, e não teste de CI
 *
 * Ela carrega **400 mil linhas** (100 mil em cada tabela de efeito) e mede o
 * plano. Rodar isso a cada CI é custo sem proteção proporcional: a existência
 * e a DEFINIÇÃO dos quatro índices já são guardadas para sempre pela INV-069g,
 * em `test/banco/spec-069-eventos-de-turma.db-spec.ts`, que roda em segundos.
 * O que esta prova mede é o PLANO, uma vez, com volume — e é isso que a
 * TASK-005 entrega.
 *
 * Mesma natureza do `prova-ac017.cjs`, que declara o mesmo no cabeçalho dele.
 *
 * ## O critério, literal da spec
 *
 * | | |
 * |---|---|
 * | volume | ≥ 100 mil linhas em cada tabela de efeito, com `ANALYZE` depois |
 * | chave | de **alta seletividade** — uma ação com um efeito, não a mais movimentada |
 * | comando | `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)` |
 * | passa | o plano **nomeia o índice esperado** e o nó é `Index Scan`, `Index Only Scan` **ou** `Bitmap Index Scan` |
 * | reprova | `Seq Scan` no ramo correspondente |
 *
 * **A v2 da spec exigia literalmente `Index Scan` e reprovaria a implementação
 * correta** — a 2ª rodada mediu, viu `Index Only Scan` nos quatro (que é
 * melhor) e a AC foi reescrita. *Critério que só aceita a forma que o autor
 * imaginou é critério que pune o acerto.*
 *
 * uso: DATABASE_URL=postgresql://... node test/prova-ac013-explain.cjs
 */
const { PrismaClient } = require('@prisma/client');

const N = 100_000;
const P = 'a0690000-0000-4000-8000-';
const E = 'a0690000-0000-4000-8000-00000000e001';
const U = 'a0690000-0000-4000-8000-00000000e002';
const UAL = 'a0690000-0000-4000-8000-00000000e003';
const AL = 'a0690000-0000-4000-8000-00000000e004';
const ESP = 'a0690000-0000-4000-8000-00000000e005';
const QUA = 'a0690000-0000-4000-8000-00000000e006';
const TUR = 'a0690000-0000-4000-8000-00000000e007';
const OCU = 'a0690000-0000-4000-8000-00000000e008';

/** O id determinístico da i-ésima ação — o efeito recalcula o mesmo. */
const acaoDe = (i) => `('${P}' || lpad(${i}::text,12,'0'))::uuid`;

const db = new PrismaClient();
const q = (sql) => db.$executeRawUnsafe(sql);

const ESPERADOS = [
  { tabela: 'eventos_de_ocupacao', indice: 'eventos_acao_idx' },
  { tabela: 'eventos_de_matricula', indice: 'eventos_matricula_acao_idx' },
  { tabela: 'movimentos_de_credito', indice: 'movimentos_acao_idx' },
  { tabela: 'eventos_de_turma', indice: 'eventos_turma_acao_idx' },
];
const ACEITOS = ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'];

/** Anda o plano inteiro; um nó aceito em qualquer profundidade serve. */
function nos(plano, saida = []) {
  saida.push({ tipo: plano['Node Type'], indice: plano['Index Name'] });
  for (const filho of plano.Plans ?? []) nos(filho, saida);
  return saida;
}

async function semear() {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${E}','AC-013','ac-013-explain',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${U}','ac013-admin@x.test','x','Admin','company_admin','${E}',now()),
       ('${UAL}','ac013-aluno@x.test','x','Aluno','aluno','${E}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${AL}','${UAL}','${E}','aprovado')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESP}','${E}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUA}','${E}','Q1','${ESP}',100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${TUR}','${E}','T1','${QUA}',20)`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
     VALUES ('${OCU}','${E}','${QUA}',DATE '2036-01-01',TIME '09:00',TIME '10:00','AVULSO',now(),'${AL}',80)`,
  );
}

async function carregar() {
  // **Uma transação só.** O `acao_exige_alvo` é diferido: as 100 mil ações são
  // julgadas no COMMIT, e o tempo disso é medido junto — é o custo real do
  // mecanismo em escala, e não uma estimativa.
  const t0 = Date.now();
  await db.$transaction(
    async (tx) => {
      const g = (sql) => tx.$executeRawUnsafe(sql);
      await g(
        `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
         SELECT ('${P}' || lpad(i::text,12,'0'))::uuid,'${E}','reserva_criada','${U}'
           FROM generate_series(1,${N}) i`,
      );
      await g(
        `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
         SELECT gen_random_uuid(),'${E}',('${P}' || lpad(i::text,12,'0'))::uuid,'${OCU}','criada',gen_random_uuid()
           FROM generate_series(1,${N}) i`,
      );
      await g(
        `INSERT INTO eventos_de_matricula (id,company_id,acao_id,turma_id,aluno_id)
         SELECT gen_random_uuid(),'${E}',('${P}' || lpad(i::text,12,'0'))::uuid,'${TUR}','${AL}'
           FROM generate_series(1,${N}) i`,
      );
      await g(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
         SELECT gen_random_uuid(),'${E}','${AL}','entrada',100,'carga da AC-013','${U}',('${P}' || lpad(i::text,12,'0'))::uuid
           FROM generate_series(1,${N}) i`,
      );
      await g(
        `INSERT INTO eventos_de_turma (id,company_id,acao_id,turma_id,tipo)
         SELECT gen_random_uuid(),'${E}',('${P}' || lpad(i::text,12,'0'))::uuid,'${TUR}','professor_alterado'
           FROM generate_series(1,${N}) i`,
      );
    },
    { maxWait: 120_000, timeout: 900_000 },
  );
  console.log(`CARGA_MS=${Date.now() - t0}  (inclui o COMMIT, onde o trigger julga as ${N} acoes)`);

  for (const { tabela } of ESPERADOS) await q(`ANALYZE "${tabela}"`);
  console.log('ANALYZE=ok nas quatro tabelas de efeito');
}

async function medir() {
  // Chave de ALTA seletividade: uma ação no meio da carga, com uma linha em
  // cada tabela. A mais movimentada mediria outra coisa.
  const chave = acaoDe(N / 2);
  let reprovou = false;

  for (const { tabela, indice } of ESPERADOS) {
    const [linha] = await db.$queryRawUnsafe(
      `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)
       SELECT 1 FROM "${tabela}" x
        WHERE x."company_id" = '${E}'::uuid AND x."acao_id" = ${chave}`,
    );
    const plano = (linha['QUERY PLAN'] ?? linha.query_plan)[0];
    const achados = nos(plano.Plan);
    const usaOIndice = achados.some((n) => n.indice === indice);
    const noAceito = achados.some((n) => ACEITOS.includes(n.tipo));
    const temSeqScan = achados.some((n) => n.tipo === 'Seq Scan');
    const ok = usaOIndice && noAceito && !temSeqScan;
    if (!ok) reprovou = true;

    console.log(
      [
        ok ? 'OK  ' : 'FALHA',
        tabela.padEnd(22),
        'no=' + achados.map((n) => n.tipo).join('>'),
        'indice=' + (achados.find((n) => n.indice)?.indice ?? 'NENHUM'),
        'esperado=' + indice,
        'ms=' + plano['Execution Time'],
        'buffers_hit=' + (plano.Plan['Shared Hit Blocks'] ?? '?'),
      ].join('  '),
    );
  }
  return reprovou;
}

async function contar() {
  for (const { tabela } of ESPERADOS) {
    const [{ n }] = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${tabela}" WHERE company_id = '${E}'`,
    );
    console.log(`LINHAS ${tabela.padEnd(22)} = ${n}`);
    if (n < N) throw new Error(`${tabela} com ${n} linhas, menos que as ${N} exigidas`);
  }
}

(async () => {
  await semear();
  await carregar();
  await contar();
  const reprovou = await medir();
  console.log(`\nVEREDITO (AC-013): ${reprovou ? 'REPROVADO' : 'APROVADO'}`);
  await db.$disconnect();
  process.exitCode = reprovou ? 1 : 0;
})().catch(async (e) => {
  console.error('FALHOU:', e.message);
  await db.$disconnect();
  process.exitCode = 1;
});

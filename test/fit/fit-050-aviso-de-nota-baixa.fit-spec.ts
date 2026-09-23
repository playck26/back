/**
 * SPEC-068/FIT-050 — **o aviso de nota baixa, contra o banco de verdade.**
 *
 * ## O que só o banco decide, e está aqui por isso
 *
 * - a **UNIQUE parcial** `(origem_id, destinatario_id) WHERE tipo =
 *   'avaliacao_baixa'` casando com o `ON CONFLICT` do `INSERT`. Um predicado
 *   que não casasse daria `42P10` em produção e em nenhum mock;
 * - o **CHECK** que torna essa UNIQUE viva: sem ele, `NULL` não colide com
 *   `NULL` e o índice seria letra morta em silêncio;
 * - a **corrida real** do mesmo aluno em dois aparelhos (AC-015), que exige
 *   duas conexões — duas `Promise` no mesmo cliente podem serializar sozinhas
 *   e ficar verdes sem provar nada;
 * - a **atomicidade** da transação (AC-016), forçada por um `BEFORE INSERT`
 *   que o próprio teste instala: é a única seam que falha **dentro** da
 *   transação real, **depois** do upsert real da avaliação.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { AvaliacaoDeAulaService } from '../../src/classes/avaliacao-de-aula.service';
import { TIPO_AVALIACAO_BAIXA } from '../../src/classes/aviso-de-nota-baixa';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(600_000);
exigirBancoLocal();

const EMPRESA = '068f0500-0000-4000-8000-000000000001';
const QUADRA = '068f0500-0000-4000-8000-000000000002';
const TURMA = '068f0500-0000-4000-8000-000000000003';
const ALUNO_U = '068f0500-0000-4000-8000-000000000004';
const ALUNO = '068f0500-0000-4000-8000-000000000005';
const PROF = '068f0500-0000-4000-8000-000000000006';
/** Cinco gestores: o fan-out da AC-016 tem de ser visível na prova. */
const GESTORES = [
  '068f0500-0000-4000-8000-00000000000a',
  '068f0500-0000-4000-8000-00000000000b',
  '068f0500-0000-4000-8000-00000000000c',
  '068f0500-0000-4000-8000-00000000000d',
  '068f0500-0000-4000-8000-00000000000e',
];

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(cliente: PrismaClient = db): AvaliacaoDeAulaService {
  return new AvaliacaoDeAulaService(cliente as unknown as PrismaService);
}

/** Uma data no passado, para a aula já ter terminado. */
function ontem(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}
const AULA = ontem();

interface Aviso {
  destinatarioId: string;
  titulo: string;
  corpo: string;
  destinoUrl: string | null;
  origemId: string | null;
}

async function avisos(): Promise<Aviso[]> {
  return db.notificacao.findMany({
    where: { companyId: EMPRESA, tipo: TIPO_AVALIACAO_BAIXA },
    select: {
      destinatarioId: true,
      titulo: true,
      corpo: true,
      destinoUrl: true,
      origemId: true,
    },
    orderBy: [{ destinatarioId: 'asc' }],
  });
}

async function ocupacao(): Promise<string> {
  const linha = await db.ocupacaoQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA, origemTurmaId: TURMA },
    select: { id: true },
  });
  return linha.id;
}

async function montar(): Promise<void> {
  const hash = await bcrypt.hash('senha-do-teste', 10);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-068','spec-068-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Quadra 068',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ALUNO_U}','aluno068@teste.local','${hash}','Aluno Sentinela','aluno','${EMPRESA}',now())`,
  );
  for (const [i, gestor] of GESTORES.entries()) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${gestor}','gestor${i}-068@teste.local','${hash}','Gestor ${i}','company_admin','${EMPRESA}',now())`,
    );
  }
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${ALUNO_U}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome) VALUES ('${PROF}','${EMPRESA}','Professor')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma Sentinela','${QUADRA}','${PROF}',20,'ativa')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}',now())`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${AULA}','19:00','20:00','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-068 — o aviso de nota baixa', () => {
  it('AC-004/AC-008/AC-011: nota 1 avisa os CINCO gestores, sem nome e na turma', async () => {
    const aula = await ocupacao();
    await servico().avaliar(EMPRESA, ALUNO_U, aula, {
      nota: 1,
      comentario: 'Sentinela Comentario',
    });

    const lista = await avisos();
    // Fan-out visível: um gestor só passaria com o código errado.
    expect(lista).toHaveLength(5);
    expect(lista.map((a) => a.destinatarioId).sort()).toEqual(
      [...GESTORES].sort(),
    );
    for (const aviso of lista) {
      expect(aviso.titulo).toBe('Avaliações');
      // AC-008 — nem o nome do aluno, nem o comentário, nem o nome da turma.
      expect(aviso.corpo).not.toContain('Sentinela');
      expect(aviso.destinoUrl).not.toContain('Sentinela');
      expect(aviso.corpo).toContain('1 estrela');
      // AC-011 — a URL é da TURMA, nunca da avaliação.
      expect(aviso.destinoUrl).toBe(`/turmas/${TURMA}`);
      expect(aviso.origemId).not.toBe(TURMA);
    }
  });

  it('AC-005: nota 2 dispara; 3, 4 e 5 não disparam', async () => {
    const aula = await ocupacao();

    // **Controle positivo no mesmo arranjo** — sem ele, remover o detector
    // inteiro deixaria a segunda metade verde.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 2 });
    expect(await avisos()).toHaveLength(5);

    for (const nota of [3, 4, 5]) {
      await limparEmpresa(db, EMPRESA);
      await montar();
      const outra = await ocupacao();
      await servico().avaliar(EMPRESA, ALUNO_U, outra, { nota });
      expect(await avisos()).toHaveLength(0);
    }
  });

  it('AC-006/AC-007: regravar não duplica; 5→1 avisa; 1→2 não reavisa', async () => {
    const aula = await ocupacao();

    // AC-007, primeira metade: a nota alta não avisa.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 5 });
    expect(await avisos()).toHaveLength(0);

    // 5 → 1: entrou na faixa.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 1 });
    expect(await avisos()).toHaveLength(5);

    // AC-006 — a MESMA nota de novo: `ON CONFLICT DO NOTHING`.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 1 });
    expect(await avisos()).toHaveLength(5);

    // AC-007 — 1 → 2 continua na faixa e NÃO reavisa.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 2 });
    expect(await avisos()).toHaveLength(5);

    // AC-007 — 2 → 5 não apaga o que já foi enviado.
    await servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 5 });
    expect(await avisos()).toHaveLength(5);
  });

  it('AC-015: dois aparelhos ao mesmo tempo → UMA avaliação e UM aviso por gestor', async () => {
    const aula = await ocupacao();
    const outro = new PrismaClient();
    try {
      const resultados = await Promise.allSettled([
        servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 1 }),
        servico(outro).avaliar(EMPRESA, ALUNO_U, aula, { nota: 1 }),
      ]);

      // **Sem 500 em nenhuma das duas** — se o `upsert` do Prisma não fosse
      // atômico, a perdedora traria `P2002` e a spec manda trocar por
      // `INSERT ... ON CONFLICT ... RETURNING id`. Medido na 3ª rodada de
      // validação: o Client 6.19.3 emite `ON CONFLICT`.
      const rejeitadas = resultados.filter((r) => r.status === 'rejected');
      expect(
        rejeitadas.map((r) => (r as PromiseRejectedResult).reason),
      ).toEqual([]);

      const linhas = await db.avaliacaoDeAula.count({
        where: { companyId: EMPRESA },
      });
      expect(linhas).toBe(1);
      expect(await avisos()).toHaveLength(5);
    } finally {
      await outro.$disconnect();
    }
  });

  it('AC-016: falha no lote de avisos NÃO deixa avaliação gravada', async () => {
    const aula = await ocupacao();
    // **A seam.** Falha dentro da transação real, depois do upsert real da
    // avaliação, no INSERT real dos avisos. Limpeza idempotente: `IF EXISTS`
    // antes de instalar e remoção no `finally`.
    await q(`DROP TRIGGER IF EXISTS spec068_falha ON notificacoes`);
    await q(
      `CREATE OR REPLACE FUNCTION spec068_falha() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'SPEC-068: falha forcada no lote'; END; $$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER spec068_falha BEFORE INSERT ON notificacoes
         FOR EACH ROW WHEN (NEW.company_id = '${EMPRESA}'::uuid)
         EXECUTE FUNCTION spec068_falha()`,
    );

    try {
      await expect(
        servico().avaliar(EMPRESA, ALUNO_U, aula, { nota: 1 }),
      ).rejects.toThrow();

      // INV-068j — ou os dois existem, ou nenhum.
      expect(
        await db.avaliacaoDeAula.count({ where: { companyId: EMPRESA } }),
      ).toBe(0);
      expect(await avisos()).toHaveLength(0);
    } finally {
      await q(`DROP TRIGGER IF EXISTS spec068_falha ON notificacoes`);
      await q(`DROP FUNCTION IF EXISTS spec068_falha()`);
    }
  });

  it('INV-068g: a UNIQUE parcial só vive por causa do CHECK', async () => {
    // **As duas metades são uma coisa só.** Sem o CHECK, `NULL` não colide
    // com `NULL` e a UNIQUE aceitaria quantas linhas sem origem quisessem
    // entrar — em silêncio, até alguém receber o mesmo aviso cinco vezes.
    await expect(
      q(
        `INSERT INTO notificacoes (id,company_id,destinatario_id,tipo,titulo,corpo)
         VALUES (gen_random_uuid(),'${EMPRESA}','${GESTORES[0]}','${TIPO_AVALIACAO_BAIXA}','x','y')`,
      ),
    ).rejects.toThrow(/notificacoes_avaliacao_tem_origem_chk|23514/);
  });

  it('AC-012: um tipo que a implementação NÃO conhece aparece na caixa', async () => {
    // **A prova de que o recorte é por exclusão, e não allowlist.** Uma
    // allowlist — ainda que listasse `gesto`, `lista_espera` e
    // `avaliacao_baixa` — deixaria este caso vermelho.
    await q(
      `INSERT INTO notificacoes (id,company_id,destinatario_id,tipo,titulo,corpo)
       VALUES (gen_random_uuid(),'${EMPRESA}','${GESTORES[0]}','sentinela_tipo_futuro','Sentinela','Corpo')`,
    );

    const naCaixa = await db.notificacao.findMany({
      where: {
        companyId: EMPRESA,
        destinatarioId: GESTORES[0],
        tipo: { not: 'teste' },
      },
      select: { tipo: true },
    });
    expect(naCaixa.map((n) => n.tipo)).toContain('sentinela_tipo_futuro');
  });
});

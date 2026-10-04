/**
 * SPEC-081/TASK-004 — **a contagem de presenças por OCORRÊNCIA, contra banco
 * real** (AC-014 e a prova comportamental do AC-015).
 *
 * Dois clubes. No A, uma turma com:
 *  - X: 2 presenças (S1 ausente, S2 presente);
 *  - Y: nenhuma presença, e nenhuma chamada;
 *  - Z1 e Z2: 1 presença cada (S1 ausente) — as duas existem para S1 somar 3
 *    faltas seguidas e aparecer na evasão, que só lista quem está em risco;
 *  - W: fora da janela de 30 dias, 1 presença.
 * No B, uma ocorrência com 3 presenças.
 *
 * Valores escritos à mão: X, Z1 e Z2 são "lançadas", Y não (as quatro
 * aconteceram); na lista do professor, `marcados` é 2, 0, 1 e 1. A
 * implementação errada que isto derruba é contar por TURMA: Y receberia as
 * presenças das vizinhas, e ficaria "lançada" com 4 marcados.
 *
 * AC-018 (v9, achado 081-V8-01) — a presença DIVERGENTE: nada no banco obriga
 * a presença a ser do clube da ocorrência (LIM-081f). Os casos do fim montam
 * esse estado com `UPDATE` comum nas presenças de X e restauram as linhas em
 * `finally`, para os cinco casos acima não dependerem da ordem.
 */
import { PrismaClient } from '@prisma/client';
import { PresencaService } from '../../src/classes/presenca.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { FrequenciaService } from '../../src/frequencia/frequencia.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture, primeiroNivelSql } from './nivel-da-fixture';

jest.setTimeout(180_000);
exigirBancoLocal();

const db = new PrismaClient();
const app = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const id = (clube: string, n: string) =>
  `0810${clube}000-0000-4000-8000-${n.padStart(12, '0')}`;
const A = {
  EMPRESA: id('a', '1'),
  QUADRA: id('a', '2'),
  UPROF: id('a', '3'),
  PROF: id('a', '4'),
  TURMA: id('a', '5'),
  U1: id('a', '6'),
  S1: id('a', '7'),
  U2: id('a', '8'),
  S2: id('a', '9'),
  X: id('a', 'a1'),
  Y: id('a', 'a2'),
  Z1: id('a', 'a3'),
  Z2: id('a', 'a4'),
  W: id('a', 'a5'),
};
const B = {
  EMPRESA: id('b', '1'),
  QUADRA: id('b', '2'),
  UPROF: id('b', '3'),
  PROF: id('b', '4'),
  TURMA: id('b', '5'),
  U1: id('b', '6'),
  S1: id('b', '7'),
  U2: id('b', '8'),
  S2: id('b', '9'),
  U3: id('b', 'a'),
  S3: id('b', 'b'),
  V: id('b', 'b1'),
};

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function clube(c: {
  EMPRESA: string;
  QUADRA: string;
  UPROF: string;
  PROF: string;
  TURMA: string;
}) {
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${c.EMPRESA}','SPEC-081 ${c.EMPRESA}','spec-081-${c.EMPRESA}',now())`,
    ),
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${c.EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${c.QUADRA}','${c.EMPRESA}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${c.EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${c.UPROF}','p-${c.UPROF}@spec081.local','x','Prof','professor','${c.EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${c.PROF}','${c.EMPRESA}','Prof','${c.UPROF}',now())`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status,nivel_id) VALUES ('${c.TURMA}','${c.EMPRESA}','Turma 081','${c.QUADRA}','${c.PROF}',20,'ativa',${primeiroNivelSql(`'${c.EMPRESA}'`)})`,
  );
}

async function aluno(empresa: string, turma: string, u: string, a: string) {
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${u}','a-${u}@spec081.local','x','Aluno ${u.slice(-2)}','aluno','${empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${a}','${u}','${empresa}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turma}','${a}',now())`,
  );
}

let hora = 6;
async function aula(
  c: { EMPRESA: string; QUADRA: string; TURMA: string },
  oc: string,
  dias: number,
) {
  hora = hora >= 20 ? 6 : hora + 1;
  const h = String(hora).padStart(2, '0');
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${oc}','${c.EMPRESA}','${c.QUADRA}','${emDias(dias)}','${h}:00','${h}:50','TURMA','${c.TURMA}','pendente_pagamento',now())`,
  );
}

/** Chamada automática (sem autor humano), com as presenças dadas. */
async function chamada(
  empresa: string,
  oc: string,
  linhas: [string, 'presente' | 'ausente'][],
) {
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
     VALUES ('${oc}','TURMA','${empresa}',NULL,now(),'completa',${linhas.length},'automatica','automatica',clock_timestamp())`,
  );
  for (const [alunoId, status] of linhas) {
    await q(
      `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
       VALUES (gen_random_uuid(),'${empresa}','${oc}','TURMA','${alunoId}','${status}',NULL,now())`,
    );
  }
}

beforeAll(async () => {
  await limparEmpresa(db, A.EMPRESA);
  await limparEmpresa(db, B.EMPRESA);

  await clube(A);
  await aluno(A.EMPRESA, A.TURMA, A.U1, A.S1);
  await aluno(A.EMPRESA, A.TURMA, A.U2, A.S2);
  await aula(A, A.X, -3);
  await aula(A, A.Y, -2);
  await aula(A, A.Z1, -5);
  await aula(A, A.Z2, -6);
  await aula(A, A.W, -40);
  await chamada(A.EMPRESA, A.X, [
    [A.S1, 'ausente'],
    [A.S2, 'presente'],
  ]);
  await chamada(A.EMPRESA, A.Z1, [[A.S1, 'ausente']]);
  await chamada(A.EMPRESA, A.Z2, [[A.S1, 'ausente']]);
  await chamada(A.EMPRESA, A.W, [[A.S1, 'presente']]);

  await clube(B);
  await aluno(B.EMPRESA, B.TURMA, B.U1, B.S1);
  await aluno(B.EMPRESA, B.TURMA, B.U2, B.S2);
  await aluno(B.EMPRESA, B.TURMA, B.U3, B.S3);
  await aula(B, B.V, -3);
  await chamada(B.EMPRESA, B.V, [
    [B.S1, 'presente'],
    [B.S2, 'presente'],
    [B.S3, 'ausente'],
  ]);
});

afterAll(async () => {
  await limparEmpresa(db, A.EMPRESA);
  await limparEmpresa(db, B.EMPRESA);
  await db.$disconnect();
});

describe('SPEC-081 AC-014/AC-015 — presença contada por ocorrência', () => {
  it('daTurma: 4 aulas aconteceram, 3 lançadas (X, Z1, Z2) — Y não', async () => {
    const r = await new FrequenciaService(app).daTurma(A.EMPRESA, A.TURMA, 30);
    expect(r.cobertura.aconteceram).toBe(4);
    expect(r.cobertura.lancadas).toBe(3);
  });

  it('doAluno: a turma de S1 tem as mesmas 3 lançadas de 4', async () => {
    const r = await new FrequenciaService(app).doAluno(A.EMPRESA, A.S1, 30);
    const daTurma = r.porTurma.find((t) => t.turmaId === A.TURMA);
    expect(daTurma?.cobertura.aconteceram).toBe(4);
    expect(daTurma?.cobertura.lancadas).toBe(3);
  });

  it('evasao: S1 (3 faltas seguidas) aparece, com a cobertura de 3 lançadas de 4', async () => {
    const r = await new FrequenciaService(app).evasao(A.EMPRESA, 30);
    const s1 = r.alunos.find((x) => x.alunoId === A.S1);
    expect(s1?.motivo).toBe('faltas_seguidas');
    expect(s1?.cobertura.aconteceram).toBe(4);
    expect(s1?.cobertura.lancadas).toBe(3);
  });

  it('lista do professor: marcados 2 em X, 0 em Y, 1 em Z1 e em Z2', async () => {
    const r = await new PresencaService(app).ocorrenciasDaTurma(
      A.EMPRESA,
      A.UPROF,
      A.TURMA,
      30,
    );
    const marcados = Object.fromEntries(
      r.data.map((o) => [o.ocupacaoId, o.marcados]),
    );
    expect(marcados).toEqual({ [A.X]: 2, [A.Y]: 0, [A.Z1]: 1, [A.Z2]: 1 });
  });

  it('o clube B não interfere: a sua ocorrência tem 3 marcados, e só ela', async () => {
    const r = await new PresencaService(app).ocorrenciasDaTurma(
      B.EMPRESA,
      B.UPROF,
      B.TURMA,
      30,
    );
    expect(r.data.map((o) => [o.ocupacaoId, o.marcados])).toEqual([[B.V, 3]]);
  });
});

/**
 * SPEC-081/AC-018 — a presença divergente não conta para o clube da ocorrência.
 *
 * O estado é montado com `UPDATE` comum (sem válvula, sem desligar gatilho,
 * sem tirar constraint): a ocorrência, o `origem_tipo` e o `registrado_por`
 * nulo ficam; só `company_id` e `aluno_id` passam a ser do clube B, juntos,
 * porque a FK composta da DEF-024 amarra a presença ao aluno do mesmo clube.
 * O `finally` devolve cada linha ao que era.
 */
describe('SPEC-081 AC-018 — a presença divergente não conta para o clube da ocorrência', () => {
  type Linha = { id: string; aluno_id: string; company_id: string };

  async function presencasDeX(): Promise<Linha[]> {
    return db.$queryRawUnsafe<Linha[]>(
      `SELECT id::text, aluno_id::text, company_id::text FROM presencas WHERE ocupacao_id = '${A.X}' ORDER BY aluno_id`,
    );
  }

  /** Passa as presenças de X dos alunos dados para os alunos de B dados. */
  async function divergir(
    trocas: [deAluno: string, paraAluno: string][],
    corpo: () => Promise<void>,
  ) {
    const antes = await presencasDeX();
    expect(antes.map((l) => [l.aluno_id, l.company_id])).toEqual([
      [A.S1, A.EMPRESA],
      [A.S2, A.EMPRESA],
    ]);
    try {
      for (const [de, para] of trocas) {
        const n = await q(
          `UPDATE presencas SET company_id = '${B.EMPRESA}', aluno_id = '${para}' WHERE ocupacao_id = '${A.X}' AND aluno_id = '${de}'`,
        );
        expect(n).toBe(1);
      }
      await corpo();
    } finally {
      for (const l of antes) {
        await q(
          `UPDATE presencas SET company_id = '${l.company_id}', aluno_id = '${l.aluno_id}' WHERE id = '${l.id}'`,
        );
      }
      const depois = await presencasDeX();
      expect(depois).toEqual(antes);
    }
  }

  const contagemDaFrequencia = async () => {
    const s = new FrequenciaService(app);
    const { desde, hoje } = s['janela'](30);
    return s['presencasPorOcorrencia'](A.EMPRESA, desde, hoje, A.TURMA);
  };

  const marcadosDoProfessor = async () => {
    const r = await new PresencaService(app).ocorrenciasDaTurma(
      A.EMPRESA,
      A.UPROF,
      A.TURMA,
      30,
    );
    return Object.fromEntries(r.data.map((o) => [o.ocupacaoId, o.marcados]));
  };

  it('(a) uma das duas presenças de X vira do clube B: a contagem dá 1 e marcados 1', async () => {
    await divergir([[A.S2, B.S1]], async () => {
      const mapa = await contagemDaFrequencia();
      expect(mapa.get(A.X)).toBe(1);
      const marcados = await marcadosDoProfessor();
      expect(marcados[A.X]).toBe(1);
    });
  });

  it('(b) as duas presenças de X viram do clube B: daTurma não a lança, marcados 0', async () => {
    await divergir(
      [
        [A.S1, B.S1],
        [A.S2, B.S2],
      ],
      async () => {
        const r = await new FrequenciaService(app).daTurma(
          A.EMPRESA,
          A.TURMA,
          30,
        );
        // X continua tendo acontecido (tem cabeçalho de chamada); só deixa
        // de ter presença do clube: lançadas são Z1 e Z2.
        expect(r.cobertura.aconteceram).toBe(4);
        expect(r.cobertura.lancadas).toBe(2);
        const mapa = await contagemDaFrequencia();
        expect(mapa.has(A.X)).toBe(false);
        const marcados = await marcadosDoProfessor();
        expect(marcados[A.X]).toBe(0);
      },
    );
  });
});

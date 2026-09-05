/**
 * SPEC-031/D15 — **a escolha da ocorrência relevante, contra Postgres real.**
 *
 * ## Por que isto não podia ser teste unitário
 *
 * O predicado do `WHERE` é o teste. Com o Prisma dublado, `findFirst` devolve
 * o que o dublê mandar **independentemente do `where`** — e foi assim que a
 * primeira versão da suíte unitária desta task passou com o defeito injetado:
 * trocar `horaFim` por `horaInicio` (a leitura "estritamente futura" que a v2
 * da spec fazia) não mudava nada, porque a consulta nunca era executada.
 *
 * Aqui ela é. As duas ocorrências existem no banco ao mesmo tempo, e quem
 * escolhe é o Postgres.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ocorrenciaRelevante } from '../../src/classes/ocorrencia-relevante';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'f0150000-0000-4000-8000-000000000001';
const QUADRA = 'f0150000-0000-4000-8000-000000000002';
const ESPORTE = 'f0150000-0000-4000-8000-000000000003';
const TURMA = 'f0150000-0000-4000-8000-000000000004';

/** Meio-dia do clube em 2026-10-05. */
const AGORA = new Date('2026-10-05T15:00:00.000Z');

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','D15','spec-031-d15',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${TURMA}','${EMPRESA}','T1','${QUADRA}',20)`,
  );
}

async function ocupacao(
  data: string,
  inicio: string,
  fim: string,
  status = 'pendente_pagamento',
) {
  await q(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',DATE '${data}',TIME '${inicio}',TIME '${fim}','TURMA','${TURMA}','${status}',now())`,
  );
}

const relevante = () =>
  db.$transaction((tx) => ocorrenciaRelevante(tx, EMPRESA, TURMA, AGORA));

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('D15 — a ocorrencia relevante, contra Postgres', () => {
  /**
   * **O caso que a v2 da spec errava.** Aula das 11h às 13h (em andamento às
   * 12h) e outra na semana seguinte. Lido como "estritamente futura", o
   * Postgres devolveria a da semana que vem, o prazo daria folga de dias, e o
   * aluno sairia **durante a própria aula**.
   */
  it('a EM ANDAMENTO vence a da semana seguinte, e a antecedencia e negativa', async () => {
    await ocupacao('2026-10-05', '11:00', '13:00'); // em andamento
    await ocupacao('2026-10-12', '11:00', '13:00'); // semana seguinte

    const r = await relevante();

    expect(r.tipo).toBe('MINUTOS');
    // 11h contra 12h → −60. O SINAL é o que faz `podeCancelar` recusar.
    expect(r).toEqual({ tipo: 'MINUTOS', minutos: -60 });
  });

  it('sem aula em andamento, escolhe a PROXIMA', async () => {
    await ocupacao('2026-10-05', '18:00', '19:00'); // hoje, mais tarde
    await ocupacao('2026-10-12', '11:00', '13:00'); // semana seguinte

    // 18h contra 12h → 360 minutos.
    expect(await relevante()).toEqual({ tipo: 'MINUTOS', minutos: 360 });
  });

  /**
   * O corte é pelo `hora_fim`: a aula que **terminou** hoje não é relevante,
   * mesmo tendo acontecido depois da meia-noite de hoje.
   */
  it('aula que ja TERMINOU hoje e ignorada', async () => {
    await ocupacao('2026-10-05', '08:00', '09:00'); // terminou às 9h
    await ocupacao('2026-10-06', '10:00', '11:00'); // amanhã

    // Amanhã às 10h contra hoje meio-dia → 1440 − 120 = 1320.
    expect(await relevante()).toEqual({ tipo: 'MINUTOS', minutos: 1320 });
  });

  it('ocorrencia CANCELADA nao conta', async () => {
    await ocupacao('2026-10-05', '18:00', '19:00', 'cancelado');
    await ocupacao('2026-10-12', '11:00', '13:00');

    // Pula a cancelada de hoje e vai para a da semana seguinte:
    // 7 dias = 10080, mais 11h − 12h = −60 → 10020.
    expect(await relevante()).toEqual({ tipo: 'MINUTOS', minutos: 10020 });
  });

  it('turma sem ocorrencia nenhuma devolve SEM_OCORRENCIA', async () => {
    expect(await relevante()).toEqual({ tipo: 'SEM_OCORRENCIA' });
  });

  /**
   * A borda exata do `gte`: a aula que termina **neste minuto** ainda conta.
   * É deliberado — enquanto o relógio não passa do fim, a aula é a de hoje, e
   * a antecedência negativa recusa a saída.
   */
  it('aula que termina NESTE minuto ainda e a relevante', async () => {
    await ocupacao('2026-10-05', '10:00', '12:00'); // termina agora
    await ocupacao('2026-10-12', '11:00', '13:00');

    expect(await relevante()).toEqual({ tipo: 'MINUTOS', minutos: -120 });
  });
});

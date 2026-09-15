/**
 * SPEC-056 — **o índice do professor alcança a turma inativa** (GAP-015).
 *
 * A SPEC-031/AC-019b exige que a aula cancelada seja alcançável. O índice
 * `GET /me/teacher/classes` filtrava `status: 'ativa'`, e uma turma inativada
 * antes da primeira aula — só com aulas canceladas — ficava sem porta de
 * entrada. Aqui: o padrão continua igual (D1), e com `incluirInativas` entram as
 * inativas com aula nos últimos 90 dias ou no futuro (D2, confirmada pelo Israel).
 */
import { PrismaClient } from '@prisma/client';
import { ClassesService } from '../../src/classes/classes.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { CourtsService } from '../../src/courts/courts.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);
exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'e0560000-0000-4000-8000-000000000001';
const QUADRA = 'e0560000-0000-4000-8000-000000000002';
const UPROF_A = 'e0560000-0000-4000-8000-000000000003';
const PROF_A = 'e0560000-0000-4000-8000-000000000004';
const UPROF_B = 'e0560000-0000-4000-8000-000000000005';
const PROF_B = 'e0560000-0000-4000-8000-000000000006';

const ATIVA = 'e0560000-0000-4000-8000-0000000000a1';
const INATIVA_SO_CANCELADAS = 'e0560000-0000-4000-8000-0000000000a2';
const INATIVA_RECENTE = 'e0560000-0000-4000-8000-0000000000a3';
const INATIVA_NO_LIMITE = 'e0560000-0000-4000-8000-0000000000a4';
const INATIVA_UM_DIA_FORA = 'e0560000-0000-4000-8000-0000000000a5';
const INATIVA_ANTIGA = 'e0560000-0000-4000-8000-0000000000a6';
const INATIVA_SEM_AULA = 'e0560000-0000-4000-8000-0000000000a7';
const INATIVA_DO_B = 'e0560000-0000-4000-8000-0000000000a8';

const classes = new ClassesService(
  db as unknown as PrismaService,
  {} as unknown as CourtsService,
  {} as unknown as StudentsService,
  new ConfigOperacaoService(db as unknown as PrismaService),
);

/** A data do clube deslocada em dias — a mesma régua que o serviço usa. */
function diaDoClube(deslocamento: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + deslocamento);
  return d.toISOString().slice(0, 10);
}

async function turma(
  id: string,
  nome: string,
  status: 'ativa' | 'inativa',
  professorId = PROF_A,
) {
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status)
     VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}','${professorId}',10,'${status}')`,
  );
}

async function aula(
  turmaId: string,
  deslocamento: number,
  status: 'pendente_pagamento' | 'cancelado',
  hora = '10:00',
) {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',DATE '${diaDoClube(deslocamento)}',TIME '${hora}',TIME '${hora}','TURMA','${turmaId}','${status}',now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube SPEC-056','clube-spec-056',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Q1',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}'),100)`,
  );
  for (const [uid, pid, n] of [
    [UPROF_A, PROF_A, 'a'],
    [UPROF_B, PROF_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ('${uid}','spec056-${n}@t.local','x','Prof ${n}','professor','${EMPRESA}',now())`,
    );
    await q(
      `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${pid}','${EMPRESA}','Prof ${n}','${uid}',now())`,
    );
  }

  await turma(ATIVA, 'A - ativa', 'ativa');
  // O caso do GAP-015: inativada antes da primeira aula, só aulas canceladas.
  await turma(INATIVA_SO_CANCELADAS, 'B - inativa so canceladas', 'inativa');
  await aula(INATIVA_SO_CANCELADAS, 7, 'cancelado');
  await aula(INATIVA_SO_CANCELADAS, 14, 'cancelado');
  await turma(INATIVA_RECENTE, 'C - inativa recente', 'inativa');
  await aula(INATIVA_RECENTE, -30, 'pendente_pagamento');
  await turma(INATIVA_NO_LIMITE, 'D - inativa no limite', 'inativa');
  await aula(INATIVA_NO_LIMITE, -90, 'cancelado');
  await turma(INATIVA_UM_DIA_FORA, 'E - inativa um dia fora', 'inativa');
  await aula(INATIVA_UM_DIA_FORA, -91, 'pendente_pagamento');
  await turma(INATIVA_ANTIGA, 'F - inativa antiga', 'inativa');
  await aula(INATIVA_ANTIGA, -200, 'pendente_pagamento');
  await turma(INATIVA_SEM_AULA, 'G - inativa sem aula', 'inativa');
  await turma(INATIVA_DO_B, 'H - inativa do B', 'inativa', PROF_B);
  await aula(INATIVA_DO_B, 7, 'cancelado', '11:00');
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-056 — o índice do professor e a turma inativa', () => {
  it('AC-001: sem `incluirInativas`, a resposta é a de hoje — só as ativas', async () => {
    const lista = await classes.myTeachingClasses(EMPRESA, UPROF_A);
    expect(lista.map((t) => t.id)).toEqual([ATIVA]);
    expect(lista.map((t) => t.status)).toEqual(['ativa']);
  });

  it('AC-002: com `incluirInativas`, a inativa do professor vem marcada — inclusive a que só tem aula cancelada', async () => {
    const lista = await classes.myTeachingClasses(EMPRESA, UPROF_A, true);
    const porId = new Map(lista.map((t) => [t.id, t.status]));
    expect(porId.get(ATIVA)).toBe('ativa');
    expect(porId.get(INATIVA_SO_CANCELADAS)).toBe('inativa');
    expect(porId.get(INATIVA_RECENTE)).toBe('inativa');
    // A de outro professor, nunca.
    expect(porId.has(INATIVA_DO_B)).toBe(false);
  });

  it('AC-003: a janela é de 90 dias — o dia 90 entra, o 91 não; sem aula nenhuma não entra', async () => {
    const ids = (await classes.myTeachingClasses(EMPRESA, UPROF_A, true)).map(
      (t) => t.id,
    );
    expect(ids).toContain(INATIVA_NO_LIMITE);
    expect(ids).not.toContain(INATIVA_UM_DIA_FORA);
    expect(ids).not.toContain(INATIVA_ANTIGA);
    expect(ids).not.toContain(INATIVA_SEM_AULA);
    // Conjunto exato, para um filtro frouxo não passar por acaso.
    expect([...ids].sort()).toEqual(
      [ATIVA, INATIVA_SO_CANCELADAS, INATIVA_RECENTE, INATIVA_NO_LIMITE].sort(),
    );
  });

  it('a ficha diz o status real — a inativa não se passa por ativa (AC-005, lado do servidor)', async () => {
    const inativa = await classes.myTeachingClassDetail(
      EMPRESA,
      UPROF_A,
      INATIVA_SO_CANCELADAS,
    );
    expect(inativa.status).toBe('inativa');
    const ativa = await classes.myTeachingClassDetail(EMPRESA, UPROF_A, ATIVA);
    expect(ativa.status).toBe('ativa');
  });
});

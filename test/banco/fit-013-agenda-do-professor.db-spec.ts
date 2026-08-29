/**
 * SPEC-026 — **FIT-013: o calendário do professor, contra Postgres real.**
 *
 * O que está em julgamento é o **escopo** (INV-026a), e escopo não se prova
 * com dublê: um mock devolve o que se mandar devolver, então provaria apenas
 * que eu escrevi o `where` que eu escrevi. Aqui existem dois professores na
 * mesma empresa e uma segunda empresa — e o teste exige que nenhum veja o
 * dia do outro.
 *
 * A segunda coisa em julgamento é o **estado da chamada**, que depende de
 * uma linha existir ou não existir. "Não existir" é o caso mais importante —
 * é o dia que o professor esqueceu — e é justamente o que um dublê não sabe
 * simular sem que alguém pense nele.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { AgendaDoProfessorService } from '../../src/classes/agenda-do-professor.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0130000-0000-4000-8000-000000000001';
const OUTRA_EMPRESA = 'f0130000-0000-4000-8000-0000000000f1';
const QUADRA = 'f0130000-0000-4000-8000-000000000002';
const OUTRA_QUADRA = 'f0130000-0000-4000-8000-0000000000f2';

/** Professor A e professor B, na MESMA empresa. */
const UPROF_A = 'f0130000-0000-4000-8000-00000000000a';
const PROF_A = 'f0130000-0000-4000-8000-00000000001a';
const UPROF_B = 'f0130000-0000-4000-8000-00000000000b';
const PROF_B = 'f0130000-0000-4000-8000-00000000001b';
/** E um professor da OUTRA empresa. */
const UPROF_C = 'f0130000-0000-4000-8000-00000000000c';
const PROF_C = 'f0130000-0000-4000-8000-00000000001c';

const TURMA_A = 'f0130000-0000-4000-8000-000000000021';
const TURMA_B = 'f0130000-0000-4000-8000-000000000022';
const TURMA_C = 'f0130000-0000-4000-8000-000000000023';

const DIA_1 = '2026-09-01';
const DIA_2 = '2026-09-02';
const MES = '2026-09';

const db = new PrismaClient();
const service = new AgendaDoProfessorService(db as unknown as PrismaService);

const q = (sql: string) => db.$executeRawUnsafe(sql);

async function empresaCom(
  empresaId: string,
  quadraId: string,
  slug: string,
): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresaId}','FIT-013 ${slug}','fit-013-${slug}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${empresaId}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadraId}','${empresaId}','Q ${slug}',(SELECT id FROM esportes_de_quadra WHERE company_id='${empresaId}'),100)`,
  );
}

async function professorCom(
  usuarioId: string,
  professorId: string,
  empresaId: string,
  n: string,
): Promise<void> {
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit013-${n}@teste.local','x','Prof ${n}','professor','${empresaId}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${professorId}','${empresaId}','Prof ${n}','${usuarioId}',now())`,
  );
}

/** Uma aula (ocupação de turma). `comChamada` decide o estado esperado. */
async function aula(
  id: string,
  empresaId: string,
  quadraId: string,
  turmaId: string,
  data: string,
  hora: string,
  chamada?: 'completa' | 'desconhecida',
): Promise<void> {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES ('${id}','${empresaId}','${quadraId}',DATE '${data}',TIME '${hora}',TIME '${hora}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  if (chamada) {
    // O CHECK `chamadas_completude_esperados_check` exige `esperados > 0`
    // quando a completude é `completa`, e `NULL` quando é `desconhecida` —
    // "quem afirma completude diz sobre quantos" (SPEC-015). A primeira
    // versão desta fixture passou `0` e o banco recusou, que é o
    // comportamento certo dele.
    const esperados = chamada === 'completa' ? '3' : 'NULL';
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_em,registrada_por,updated_at,completude,esperados) VALUES ('${id}','TURMA','${empresaId}',now(),'${UPROF_A}',now(),'${chamada}',${esperados})`,
    );
  }
}

async function montar(): Promise<void> {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA_EMPRESA);

  await empresaCom(EMPRESA, QUADRA, 'a');
  await empresaCom(OUTRA_EMPRESA, OUTRA_QUADRA, 'z');

  await professorCom(UPROF_A, PROF_A, EMPRESA, 'A');
  await professorCom(UPROF_B, PROF_B, EMPRESA, 'B');
  await professorCom(UPROF_C, PROF_C, OUTRA_EMPRESA, 'C');

  for (const [turma, prof, emp, quadra, nome] of [
    [TURMA_A, PROF_A, EMPRESA, QUADRA, 'Turma do A'],
    [TURMA_B, PROF_B, EMPRESA, QUADRA, 'Turma do B'],
    [TURMA_C, PROF_C, OUTRA_EMPRESA, OUTRA_QUADRA, 'Turma do C'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${turma}','${emp}','${nome}','${quadra}','${prof}',10,'ativa')`,
    );
  }
}

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA_EMPRESA);
  await db.$disconnect();
});

describe('FIT-013 — INV-026a: o calendário só mostra o que é dele', () => {
  it('não mostra a aula de OUTRO professor da mesma empresa', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000101',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000102',
      EMPRESA,
      QUADRA,
      TURMA_B,
      DIA_1,
      '19:00',
    );

    const mesDoA = await service.resumoDoMes(EMPRESA, UPROF_A, MES);

    expect(mesDoA).toHaveLength(1);
    expect(mesDoA[0]).toEqual({ data: DIA_1, aulas: 1, pendentes: 1 });
  });

  it('e o professor B vê a dele, não a do A — o outro lado', async () => {
    // Sem esta, um filtro que devolvesse SEMPRE vazio passaria na de cima.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000101',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000102',
      EMPRESA,
      QUADRA,
      TURMA_B,
      DIA_1,
      '19:00',
    );

    const diaDoB = await service.detalheDoDia(EMPRESA, UPROF_B, DIA_1);

    expect(diaDoB).toHaveLength(1);
    expect(diaDoB[0].turmaNome).toBe('Turma do B');
  });

  it('não mostra a aula de OUTRA empresa', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000103',
      OUTRA_EMPRESA,
      OUTRA_QUADRA,
      TURMA_C,
      DIA_1,
      '18:00',
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  it('professor sem turma: mês e dia vazios, sem erro', async () => {
    await montar();

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
    expect(await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1)).toEqual([]);
  });
});

describe('FIT-013 — o estado da chamada, que é a razão da tela', () => {
  it('sem linha em `chamadas` é PENDENTE — o dia que ele esqueceu', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000111',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('pendente');
  });

  it('`completa` é FEITA', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000112',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'completa',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('feita');
  });

  it('`desconhecida` é LEGADA — chamada de antes da SPEC-015', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000113',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'desconhecida',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('legada');
  });

  it('o mês conta as pendentes separadamente das aulas', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000121',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'completa',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000122',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '19:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000123',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_2,
      '18:00',
    );

    const mes = await service.resumoDoMes(EMPRESA, UPROF_A, MES);

    expect(mes).toEqual([
      { data: DIA_1, aulas: 2, pendentes: 1 },
      { data: DIA_2, aulas: 1, pendentes: 1 },
    ]);
  });
});

describe('FIT-013 — o que NÃO é aula dele', () => {
  it('aula cancelada não entra', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000131',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await db.$executeRawUnsafe(
      `UPDATE ocupacoes_quadra SET status_pagamento='cancelado' WHERE id='f0130000-0000-4000-8000-000000000131'`,
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  it('reserva AVULSA não entra — não é aula', async () => {
    await montar();
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',DATE '${DIA_1}',TIME '07:00',TIME '08:00','AVULSO',100,'pendente_pagamento',now())`,
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  it('quadra inativa não é agenda de ninguém', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000141',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await db.$executeRawUnsafe(
      `UPDATE quadras SET status='inativa' WHERE id='${QUADRA}'`,
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });
});

describe('FIT-013 — INV-026b: o id do calendário é o id da chamada', () => {
  it('o `ocupacaoId` devolvido existe em `ocupacoes_quadra` como aula dele', async () => {
    // Se os dois divergirem, o caminho do pedido — dia → aula → chamada —
    // quebra no último passo. E quebraria em silêncio, porque cada metade
    // funciona sozinha.
    await montar();
    const ID = 'f0130000-0000-4000-8000-000000000151';
    await aula(ID, EMPRESA, QUADRA, TURMA_A, DIA_1, '18:00');

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.ocupacaoId).toBe(ID);
    // A chamada é gravada por `ocupacao_id` + `origem_tipo`: o par tem de
    // existir, senão o `PUT` da chamada não acha o que atualizar.
    const ocupacao = await db.ocupacaoQuadra.findUnique({
      where: { id: aulaDoDia.ocupacaoId },
      select: { origemTipo: true, origemTurmaId: true },
    });
    expect(ocupacao?.origemTipo).toBe('TURMA');
    expect(ocupacao?.origemTurmaId).toBe(TURMA_A);
  });

  it('as aulas do dia saem ordenadas por horário', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000161',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '20:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000162',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '07:00',
    );

    const dia = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(dia.map((a) => a.horaInicio)).toEqual(['07:00', '20:00']);
  });
});

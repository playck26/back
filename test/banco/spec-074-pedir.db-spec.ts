/**
 * SPEC-074/TASK-002 — **pedir, listar e cancelar o aviso, contra o banco.**
 *
 * As guardas da D2 dependem de dado real — a ocupação do dia, o expediente
 * resolvido, o vínculo do aluno, o índice parcial —, e um dublê que devolve a
 * lista que eu escrevi provaria só que eu sei escrever listas (a mesma divisão
 * do `reposicoes.e2e-spec.ts`). O que só existe no HTTP — papel e validação do
 * corpo — está em `test/pre-reserva.e2e-spec.ts`.
 *
 * O relógio entra por `agora`, injetado: a regra do passado é provável sem
 * esperar.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { PreReservaService } from '../../src/pre-reserva/pre-reserva.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { StudentsService } from '../../src/people/students.service';
import {
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
  parseDateOnly,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '074d0740-0000-4000-8000-00000000000a';
const OUTRA = '074d0740-0000-4000-8000-00000000000b';
const QUADRA = '074d0740-0000-4000-8000-00000000001a';
/** Quadra da mesma empresa, para o dia inteiro ocupado do teto (AC-006). */
const QUADRA_CHEIA = '074d0740-0000-4000-8000-00000000001c';
const QUADRA_INATIVA = '074d0740-0000-4000-8000-00000000001d';
const QUADRA_OUTRA = '074d0740-0000-4000-8000-00000000001b';
const TURMA = '074d0740-0000-4000-8000-00000000004a';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const p = db as unknown as PrismaService;
const servico = () =>
  new PreReservaService(
    p,
    new HorarioFuncionamentoService(p),
    new StudentsService(p),
  );

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DIA = emDias(3);

let seq = 0;
async function aluno(
  empresa = EMPRESA,
  status: 'ativo' | 'inativo' = 'ativo',
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(4, '0');
  const usuarioId = `074d0740-0000-4000-8000-10000000${s}`;
  const alunoId = `074d0740-0000-4000-8000-20000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','p074.${seq}@x.com','h','A','aluno','${empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${empresa}','aprovado','${status}')`,
  );
  return { alunoId, usuarioId };
}

async function avulsa(opcoes: {
  alunoId: string;
  quadra?: string;
  inicio?: string;
  fim?: string;
  status?: string;
}): Promise<void> {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${opcoes.quadra ?? QUADRA}','${DIA}','${opcoes.inicio ?? '10:00'}','${opcoes.fim ?? '11:00'}','AVULSO','${opcoes.alunoId}',80,'${opcoes.status ?? 'pendente_pagamento'}',now())`,
  );
}

async function aulaDeTurma(inicio: string, fim: string): Promise<void> {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${DIA}','${inicio}','${fim}','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
}

/** O `{ status, code }` da recusa. Uma instrução que passasse não é recusa. */
async function recusa(
  promessa: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof HttpException) {
      const r = erro.getResponse() as { code?: string };
      return { status: erro.getStatus(), code: r.code };
    }
    throw erro;
  }
  throw new Error('esperava recusa, e o pedido passou');
}

const pedir = (
  usuarioId: string,
  opcoes: { quadraId?: string; horaInicio?: string; data?: string } = {},
  agora?: Date,
) =>
  servico().pedir(
    EMPRESA,
    usuarioId,
    {
      quadraId: opcoes.quadraId ?? QUADRA,
      data: opcoes.data ?? DIA,
      horaInicio: opcoes.horaInicio ?? '10:00',
    },
    agora,
  );

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA, 'A'],
    [OUTRA, 'B'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-074 pedir ${nome}','spec-074-p-${nome.toLowerCase()}-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
  }
  for (const [quadra, emp, status] of [
    [QUADRA, EMPRESA, 'ativa'],
    [QUADRA_CHEIA, EMPRESA, 'ativa'],
    [QUADRA_INATIVA, EMPRESA, 'inativa'],
    [QUADRA_OUTRA, OUTRA, 'ativa'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80,'${status}')`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','T','${QUADRA}',4,'ativa')`,
  );
}

async function limparPedidos(): Promise<void> {
  await q(
    `DELETE FROM pre_reservas WHERE company_id IN ('${EMPRESA}','${OUTRA}')`,
  );
  await q(
    `DELETE FROM ocupacoes_quadra WHERE company_id IN ('${EMPRESA}','${OUTRA}')`,
  );
}

beforeAll(async () => {
  for (const emp of [EMPRESA, OUTRA]) await limparEmpresa(db, emp);
  await montar();
});

beforeEach(limparPedidos);

afterAll(async () => {
  for (const emp of [EMPRESA, OUTRA]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

describe('SPEC-074/TASK-002 — pedir aviso de horário', () => {
  it('AC-001 — ocupado por reserva AVULSA de outro: 201, `aguardando`, e o fim é o início + 1h', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId });

    const pedido = await pedir(eu.usuarioId);

    expect(pedido).toMatchObject({
      quadraId: QUADRA,
      data: DIA,
      horaInicio: '10:00',
      horaFim: '11:00',
      estado: 'aguardando',
    });
  });

  it('AC-001 — ocupado por AULA DE TURMA também vale', async () => {
    const eu = await aluno();
    await aulaDeTurma('10:00', '11:00');

    const pedido = await pedir(eu.usuarioId);
    expect(pedido.estado).toBe('aguardando');
  });

  it('AC-002 — horário LIVRE: 409 `HORARIO_LIVRE`, e nenhuma linha gravada', async () => {
    const eu = await aluno();

    expect(await recusa(pedir(eu.usuarioId))).toEqual({
      status: 409,
      code: 'HORARIO_LIVRE',
    });
    expect(await db.preReserva.count({ where: { companyId: EMPRESA } })).toBe(
      0,
    );
  });

  it('AC-002 — a borda SEMIABERTA: ocupação das 11h não ocupa o slot das 10h, e reserva cancelada não ocupa nada', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId, inicio: '11:00', fim: '12:00' });
    await avulsa({ alunoId: dono.alunoId, status: 'cancelado' });

    expect((await recusa(pedir(eu.usuarioId))).code).toBe('HORARIO_LIVRE');
  });

  it('AC-003 — pedir duas vezes: 409 `PRE_RESERVA_DUPLICADA`; depois de CANCELAR, e depois de AVISADO, passa de novo', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId });

    const primeiro = await pedir(eu.usuarioId);
    expect(await recusa(pedir(eu.usuarioId))).toEqual({
      status: 409,
      code: 'PRE_RESERVA_DUPLICADA',
    });

    await servico().cancelar(EMPRESA, eu.usuarioId, primeiro.id);
    const segundo = await pedir(eu.usuarioId);

    // "avisada" é do varredor; aqui o estado é posto à mão para provar SÓ o
    // índice parcial (decisão 4: perdeu a corrida, pede de novo).
    await q(
      `UPDATE pre_reservas SET estado = 'avisada', avisada_em = now(), concluida_em = now() WHERE id = '${segundo.id}'`,
    );
    const terceiro = await pedir(eu.usuarioId);
    expect(terceiro.estado).toBe('aguardando');
  });

  it('AC-004 — o horário que JÁ COMEÇOU: 422 `HORARIO_NO_PASSADO`', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId });
    const umMinutoDepois = new Date(
      instanteNoFusoDoClube(
        parseDateOnly(DIA),
        parseTimeOnly('10:00'),
      ).getTime() + 60_000,
    );

    expect(await recusa(pedir(eu.usuarioId, {}, umMinutoDepois))).toEqual({
      status: 422,
      code: 'HORARIO_NO_PASSADO',
    });
  });

  it('AC-004 — FORA DO EXPEDIENTE: 422 `FORA_DO_EXPEDIENTE` (sem horário configurado, vale 06h–22h)', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId, inicio: '22:00', fim: '23:00' });

    expect(await recusa(pedir(eu.usuarioId, { horaInicio: '22:00' }))).toEqual({
      status: 422,
      code: 'FORA_DO_EXPEDIENTE',
    });
  });

  it('AC-004 — QUADRA INATIVA: 422 `QUADRA_INATIVA`', async () => {
    const eu = await aluno();
    expect(
      await recusa(pedir(eu.usuarioId, { quadraId: QUADRA_INATIVA })),
    ).toEqual({ status: 422, code: 'QUADRA_INATIVA' });
  });

  it('AC-004 — ALUNO INATIVO: 422 `ALUNO_INATIVO`', async () => {
    const dono = await aluno();
    const desligado = await aluno(EMPRESA, 'inativo');
    await avulsa({ alunoId: dono.alunoId });

    expect(await recusa(pedir(desligado.usuarioId))).toEqual({
      status: 422,
      code: 'ALUNO_INATIVO',
    });
  });

  it('AC-004 — quadra de OUTRA empresa: 404, que não revela que ela existe', async () => {
    const eu = await aluno();
    expect(
      (await recusa(pedir(eu.usuarioId, { quadraId: QUADRA_OUTRA }))).status,
    ).toBe(404);
  });

  it('AC-005 — ocupado pela reserva avulsa do PRÓPRIO aluno: 409 `HORARIO_JA_E_SEU`', async () => {
    const eu = await aluno();
    await avulsa({ alunoId: eu.alunoId });

    expect(await recusa(pedir(eu.usuarioId))).toEqual({
      status: 409,
      code: 'HORARIO_JA_E_SEU',
    });
  });

  it('AC-006 — com 10 pedidos vivos, o 11º: 422 `LIMITE_DE_PRE_RESERVAS`; com um cancelado, passa', async () => {
    const dono = await aluno();
    const eu = await aluno();
    // Um dia inteiro ocupado: onze slots diferentes, todos pedíveis.
    await avulsa({
      alunoId: dono.alunoId,
      quadra: QUADRA_CHEIA,
      inicio: '06:00',
      fim: '22:00',
    });
    const horas = Array.from(
      { length: 11 },
      (_, i) => `${String(6 + i).padStart(2, '0')}:00`,
    );
    const dez: { id: string }[] = [];
    for (const hora of horas.slice(0, 10)) {
      dez.push(
        await pedir(eu.usuarioId, { quadraId: QUADRA_CHEIA, horaInicio: hora }),
      );
    }

    expect(
      await recusa(
        pedir(eu.usuarioId, { quadraId: QUADRA_CHEIA, horaInicio: horas[10] }),
      ),
    ).toEqual({ status: 422, code: 'LIMITE_DE_PRE_RESERVAS' });

    await servico().cancelar(EMPRESA, eu.usuarioId, dez[0].id);
    const decimoPrimeiro = await pedir(eu.usuarioId, {
      quadraId: QUADRA_CHEIA,
      horaInicio: horas[10],
    });
    expect(decimoPrimeiro.estado).toBe('aguardando');
  });

  it('AC-015 — cancelar: `cancelada`; de novo: 404; o de OUTRO aluno: 404, e o dele continua vivo', async () => {
    const dono = await aluno();
    const eu = await aluno();
    const outro = await aluno();
    await avulsa({ alunoId: dono.alunoId });
    const meu = await pedir(eu.usuarioId);
    const dele = await pedir(outro.usuarioId);

    await servico().cancelar(EMPRESA, eu.usuarioId, meu.id);
    expect(
      (await db.preReserva.findUniqueOrThrow({ where: { id: meu.id } })).estado,
    ).toBe('cancelada');
    expect(
      (await recusa(servico().cancelar(EMPRESA, eu.usuarioId, meu.id))).status,
    ).toBe(404);
    expect(
      (await recusa(servico().cancelar(EMPRESA, eu.usuarioId, dele.id))).status,
    ).toBe(404);
    expect(
      (await db.preReserva.findUniqueOrThrow({ where: { id: dele.id } }))
        .estado,
    ).toBe('aguardando');
  });

  it('AC-016 — listar: só os VIVOS do próprio aluno, por início; o de outro aluno e o de outra empresa não aparecem', async () => {
    const dono = await aluno();
    const eu = await aluno();
    const outro = await aluno();
    const deFora = await aluno(OUTRA);
    await avulsa({ alunoId: dono.alunoId, inicio: '08:00', fim: '12:00' });
    const onze = await pedir(eu.usuarioId, { horaInicio: '11:00' });
    const oito = await pedir(eu.usuarioId, { horaInicio: '08:00' });
    const nove = await pedir(eu.usuarioId, { horaInicio: '09:00' });
    await servico().cancelar(EMPRESA, eu.usuarioId, nove.id);
    await pedir(outro.usuarioId, { horaInicio: '08:00' });
    await q(
      `INSERT INTO pre_reservas (id,company_id,aluno_id,quadra_id,data,hora_inicio,hora_fim,inicio_em)
       VALUES (gen_random_uuid(),'${OUTRA}','${deFora.alunoId}','${QUADRA_OUTRA}','${DIA}','08:00','09:00',now() + interval '3 days')`,
    );

    const meus = await servico().meus(EMPRESA, eu.usuarioId);
    expect(meus.map((m) => m.id)).toEqual([oito.id, onze.id]);
  });

  it('AC-023 (criação) — o slot das 21h locais tem `inicio_em` às 00h UTC do DIA SEGUINTE', async () => {
    const dono = await aluno();
    const eu = await aluno();
    await avulsa({ alunoId: dono.alunoId, inicio: '21:00', fim: '22:00' });

    const pedido = await pedir(eu.usuarioId, { horaInicio: '21:00' });

    const linha = await db.preReserva.findUniqueOrThrow({
      where: { id: pedido.id },
    });
    const diaSeguinte = parseDateOnly(DIA);
    diaSeguinte.setUTCDate(diaSeguinte.getUTCDate() + 1);
    // São Paulo é UTC-3 sem horário de verão: 21h locais = 00h UTC do dia
    // seguinte. Um `Date.UTC(dia, 21h)` daria 21h UTC — três horas de
    // diferença, e o aviso expiraria às 18h locais.
    expect(linha.inicioEm.toISOString()).toBe(
      `${diaSeguinte.toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
  });
});

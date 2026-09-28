/**
 * SPEC-077/TASK-003 — **o que a matriz da SPEC-034 prometia e nenhum teste
 * afirmava**, no Back e contra o Postgres.
 *
 * Mover reserva (`moveBooking`) e cancelar ocorrência de turma
 * (`cancelarOcorrencia`). Cada caso relê a LINHA depois do gesto: a resposta
 * do serviço sozinha não prova o que ficou no banco, e "não mudou" só se
 * afirma comparando com o que havia antes.
 *
 * As provas por HTTP (o `{}`, o `403` do aluno, o motivo) moram em
 * `test/agenda.e2e-spec.ts`; a sabotagem do `registrar` com o app real, em
 * `test/fit/spec-034-auditoria.fit-spec.ts`; as concorrentes, no `fit-022`.
 */
import { PrismaClient } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { diaNoFuturo, somarDias } from './datas-relativas';
import { AgendaService } from '../../src/courts/agenda.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const id = (n: number) =>
  'f0770340-0000-4000-8000-' + String(n).padStart(12, '0');
const EMPRESA = id(1);
const ESPORTE = id(2);
/** Aberta das 06h às 23h todo dia. */
const Q1 = id(3);
/** Aberta só das 06h às 12h — o expediente diferente que os casos usam. */
const Q2 = id(4);
const UADMIN = id(5);
const UALUNO = id(6);
const ALUNO = id(7);
const UPROF = id(8);
const PROF = id(9);
const TURMA_A = id(10);
const TURMA_B = id(11);

const DIA = diaNoFuturo(20);
let dias = 0;
/** Um dia só do caso: os que ocupam o mesmo horário não podem se esbarrar na EXCLUDE. */
const diaUnico = () => somarDias(DIA, 40 + ++dias);

const horarios = new HorarioFuncionamentoService(
  db as unknown as PrismaService,
);
const courts = new CourtsService(
  db as unknown as PrismaService,
  {
    exigirAlunoOperante: () => undefined,
  } as unknown as StudentsService,
  horarios,
  {
    resolver: () => ({ imagemUrl: null }),
  } as unknown as ImagemDaQuadraService,
  new ConfigOperacaoService(db as unknown as PrismaService),
  new CreditosService(),
  { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
);
const classes = new ClassesService(
  db as unknown as PrismaService,
  courts,
  {} as unknown as StudentsService,
  new ConfigOperacaoService(db as unknown as PrismaService),
);
const agenda = new AgendaService(db as unknown as PrismaService, horarios);

let seq = 100;

/** Reserva AVULSA do aluno, pendente, R$ 100. */
async function reserva(
  hora = '10:00',
  fim = '11:00',
  data = DIA,
  quadra = Q1,
): Promise<string> {
  const r = id(++seq);
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,status_pagamento,valor,updated_at)
           VALUES ('${r}','${EMPRESA}','${quadra}','${data}','${hora}','${fim}','AVULSO','${ALUNO}','pendente_pagamento',100,now())`);
  return r;
}

/** Ocorrência de turma. */
async function ocorrencia(
  turma: string,
  hora: string,
  fim: string,
  data = DIA,
): Promise<string> {
  const r = id(++seq);
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
           VALUES ('${r}','${EMPRESA}','${Q1}','${data}','${hora}','${fim}','TURMA','${turma}','pendente_pagamento',now())`);
  return r;
}

interface Linha {
  quadra_id: string;
  data: string;
  hora_inicio: string;
  hora_fim: string;
  aluno_id: string | null;
  valor: string | null;
  status_pagamento: string;
  transicao_id: string | null;
}

async function linha(ocupacao: string): Promise<Linha> {
  const [l] = await db.$queryRawUnsafe<Linha[]>(
    `SELECT quadra_id::text, data::text, hora_inicio::text, hora_fim::text,
            aluno_id::text, valor::text, status_pagamento::text, transicao_id::text
       FROM ocupacoes_quadra WHERE id = '${ocupacao}'`,
  );
  return l;
}

/** Os eventos da ocupação, com a ação de cada um. */
async function rastro(ocupacao: string) {
  return db.$queryRawUnsafe<
    {
      evento: string;
      acao: string;
      motivo: string | null;
      transicao_id: string;
    }[]
  >(
    `SELECT e.tipo::text AS evento, a.tipo::text AS acao, a.motivo,
            e.transicao_id::text
       FROM eventos_de_ocupacao e
       JOIN acoes_administrativas a ON a.id = e.acao_id
      WHERE e.ocupacao_id = '${ocupacao}'
      ORDER BY e.criado_em`,
  );
}

async function acoesDaEmpresa(): Promise<number> {
  const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM acoes_administrativas WHERE company_id = '${EMPRESA}'`,
  );
  return n;
}

/** O código da recusa, ou `aceito`. */
const codigoDe = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'aceito';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ?? (e as { name?: string }).name ?? 'erro';
  }
};

/**
 * O relógio do Node parado no instante — o molde `comNodeEm` da SPEC-076. Os
 * timers ficam reais: o Prisma precisa deles.
 */
async function comNodeEm<T>(instante: Date, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({
    now: instante,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'queueMicrotask',
    ],
  });
  try {
    expect(Date.now()).toBe(instante.getTime());
    return await fn();
  } finally {
    jest.useRealTimers();
  }
}

const noClube = (data: string, hora: string) =>
  new Date(`${data}T${hora}:00.000-03:00`);

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-077 034','spec-077-034',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${UADMIN}','admin@s077-034.test','x','Admin','company_admin','${EMPRESA}',now()),
       ('${UALUNO}','aluno@s077-034.test','x','Aluno','aluno','${EMPRESA}',now()),
       ('${UPROF}','prof@s077-034.test','x','Prof','professor','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Prof','${UPROF}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES
       ('${Q1}','${EMPRESA}','Q1','${ESPORTE}',100),
       ('${Q2}','${EMPRESA}','Q2','${ESPORTE}',100)`,
  );
  for (const [quadra, fim] of [
    [Q1, '23:00'],
    [Q2, '12:00'],
  ] as const) {
    await q(
      `INSERT INTO horarios_funcionamento
         (id, company_id, quadra_id, dia_semana, fechado, hora_inicio, hora_fim, created_at, updated_at)
       SELECT gen_random_uuid(), '${EMPRESA}', '${quadra}', d, false, '06:00', '${fim}', now(), now()
         FROM generate_series(0, 6) AS d`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade) VALUES
       ('${TURMA_A}','${EMPRESA}','Turma A','${Q1}','${PROF}',20),
       ('${TURMA_B}','${EMPRESA}','Turma B','${Q1}','${PROF}',20)`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-077/AC-015 — mover muda só quadra, data e hora (034 AC-004/007/008)', () => {
  it('#19: os quatro campos novos; aluno, valor e status IGUAIS', async () => {
    const r = await reserva('10:00', '11:00');
    const antes = await linha(r);
    const destino = somarDias(DIA, 1);

    await courts.moveBooking(
      EMPRESA,
      r,
      { quadraId: Q2, data: destino, horaInicio: '08:00', horaFim: '09:00' },
      UADMIN,
    );

    const depois = await linha(r);
    expect(depois).toMatchObject({
      quadra_id: Q2,
      data: destino,
      hora_inicio: '08:00:00',
      hora_fim: '09:00:00',
      // Mover não é recontratar (REQ-002 da 034).
      aluno_id: antes.aluno_id,
      valor: antes.valor,
      status_pagamento: antes.status_pagamento,
    });
    expect(antes.valor).toBe('100.00');
    expect(antes.aluno_id).toBe(ALUNO);
  });

  it('#21: quadra LIVRE, horário FECHADO ⇒ 422 FORA_DO_EXPEDIENTE, e a linha não muda', async () => {
    const r = await reserva('10:00', '11:00');
    const antes = await linha(r);

    // A Q2 fecha às 12h: das 13h às 14h ela está vazia e fechada.
    expect(
      await codigoDe(() =>
        courts.moveBooking(
          EMPRESA,
          r,
          { quadraId: Q2, horaInicio: '13:00', horaFim: '14:00' },
          UADMIN,
        ),
      ),
    ).toBe('FORA_DO_EXPEDIENTE');
    expect(await linha(r)).toEqual(antes);
  });

  it('#22: ocorrência de TURMA ⇒ 422 OCUPACAO_DE_TURMA, e a linha não muda', async () => {
    const o = await ocorrencia(TURMA_A, '07:00', '08:00');
    const antes = await linha(o);

    expect(
      await codigoDe(() =>
        courts.moveBooking(
          EMPRESA,
          o,
          { horaInicio: '15:00', horaFim: '16:00' },
          UADMIN,
        ),
      ),
    ).toBe('OCUPACAO_DE_TURMA');
    expect(await linha(o)).toEqual(antes);
  });
});

describe('SPEC-077/AC-017 — reserva iniciada não se move (034 AC-010b)', () => {
  it.each([
    ['para o futuro', (d: string) => ({ data: somarDias(d, 2) })],
    ['para o passado', (d: string) => ({ data: somarDias(d, -3) })],
    ['para outra quadra', () => ({ quadraId: Q2 })],
  ])(
    '#26: iniciada há 2 min, %s ⇒ 409 PRAZO_DE_CANCELAMENTO, linha intacta, sem `reserva_movida`',
    async (_c, destinoDe) => {
      const d = diaUnico();
      const r = await reserva('19:00', '20:00', d);
      const antes = await linha(r);
      const acoes = await acoesDaEmpresa();

      const codigo = await comNodeEm(noClube(d, '19:02'), () =>
        codigoDe(() => courts.moveBooking(EMPRESA, r, destinoDe(d), UADMIN)),
      );

      expect(codigo).toBe('PRAZO_DE_CANCELAMENTO');
      expect(await linha(r)).toEqual(antes);
      expect(await rastro(r)).toEqual([]);
      expect(await acoesDaEmpresa()).toBe(acoes);
    },
  );
});

describe('SPEC-077/AC-019 — mover para cima de reserva ATIVA (034 AC-011)', () => {
  it('#28 (i): pelo serviço, em sequência ⇒ 409 com `conflictWith`, sem retry', async () => {
    const alvo = await reserva('12:00', '13:00', DIA, Q1);
    const r = await reserva('14:00', '15:00', DIA, Q1);
    const antes = await linha(r);
    const retentativas = courts.retentativasDeMover;

    const erro = await courts
      .moveBooking(
        EMPRESA,
        r,
        { horaInicio: '12:00', horaFim: '13:00' },
        UADMIN,
      )
      .then(
        () => null,
        (e: { getStatus?: () => number; getResponse?: () => unknown }) => e,
      );

    expect(erro?.getStatus?.()).toBe(409);
    expect(erro?.getResponse?.()).toMatchObject({
      conflictWith: { ocupacaoId: alvo, origemTipo: 'AVULSO' },
    });
    // Conflito visível na pré-checagem não é corrida: nada de segunda volta.
    expect(courts.retentativasDeMover).toBe(retentativas);
    expect(await linha(r)).toEqual(antes);
  });

  it('#28 (ii): o `UPDATE` CRU por cima da outra ⇒ 23P01 — a EXCLUDE é quem garante', async () => {
    await reserva('16:00', '17:00', DIA, Q1);
    const r = await reserva('18:00', '19:00', DIA, Q1);

    // A forma permanente da sabotagem "tirar a pré-checagem": sem ela, o que
    // sobra é o banco, e o banco recusa.
    const erro = await q(
      `UPDATE ocupacoes_quadra SET hora_inicio = '16:00', hora_fim = '17:00' WHERE id = '${r}'`,
    ).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toContain('23P01');
    expect((erro as Error).message).toContain('no_overlap_por_quadra');
  });
});

describe('SPEC-077/AC-020 a AC-022 — cancelar ocorrência (034 AC-012 a 015, 017)', () => {
  it('#30 + #32 + #34: cancelar duas vezes escreve UMA vez; já cancelada E já iniciada resolve sem 409; o motivo fica na ação', async () => {
    const d = diaUnico();
    const o = await ocorrencia(TURMA_A, '10:00', '11:00', d);
    const acoes = await acoesDaEmpresa();

    await classes.cancelarOcorrencia(
      EMPRESA,
      TURMA_A,
      o,
      'Chuva forte',
      UADMIN,
    );
    const depoisDaPrimeira = await linha(o);
    // Retentativa de rede: sem escrita, sem erro.
    await classes.cancelarOcorrencia(EMPRESA, TURMA_A, o, 'De novo', UADMIN);
    // E depois de a aula ter começado: a idempotência vem ANTES do corte.
    await comNodeEm(noClube(d, '10:30'), () =>
      classes.cancelarOcorrencia(EMPRESA, TURMA_A, o, 'Mais uma', UADMIN),
    );

    expect(depoisDaPrimeira.status_pagamento).toBe('cancelado');
    expect(await linha(o)).toEqual(depoisDaPrimeira);
    expect(await acoesDaEmpresa()).toBe(acoes + 1);
    const eventos = await rastro(o);
    expect(eventos).toEqual([
      {
        evento: 'cancelada',
        acao: 'aula_cancelada',
        // #32 — o motivo ACEITO, gravado na ação (034 AC-014).
        motivo: 'Chuva forte',
        // #34 — o `transicao_id` do evento é o da ocupação (034 AC-017).
        transicao_id: depoisDaPrimeira.transicao_id,
      },
    ]);
  });

  it('#31: a cancelada SAI da agenda do dia e da semana, e o horário volta a aceitar reserva', async () => {
    const o = await ocorrencia(TURMA_A, '20:00', '21:00');
    const idsDoDia = async () =>
      (await agenda.detalheDoDia(EMPRESA, DIA)).map((i) => i.id);
    const idsDaSemana = async () =>
      (await agenda.semanaDe(EMPRESA, DIA)).flatMap((d) =>
        d.itens.map((i) => i.id),
      );
    // Controle: antes de cancelar, as duas leituras a trazem.
    expect(await idsDoDia()).toContain(o);
    expect(await idsDaSemana()).toContain(o);

    await classes.cancelarOcorrencia(EMPRESA, TURMA_A, o, 'Feriado', UADMIN);

    expect(await idsDoDia()).not.toContain(o);
    expect(await idsDaSemana()).not.toContain(o);
    const nova = (await courts.createBooking(
      EMPRESA,
      {
        quadraId: Q1,
        data: DIA,
        slots: [{ horaInicio: '20:00', horaFim: '21:00' }],
      },
      UADMIN,
    )) as { reservas: { id: string }[] };
    expect(nova.reservas).toHaveLength(1);
  });

  it('#33: a URL da turma B não cancela a ocorrência da A ⇒ 404, ocorrência intacta', async () => {
    const o = await ocorrencia(TURMA_A, '08:00', '09:00');
    const antes = await linha(o);
    const acoes = await acoesDaEmpresa();

    await expect(
      classes.cancelarOcorrencia(EMPRESA, TURMA_B, o, 'Engano', UADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await linha(o)).toEqual(antes);
    expect(await acoesDaEmpresa()).toBe(acoes);
  });

  it('#34: mover grava UMA ação `reserva_movida` e UM evento `movida`, com o `transicao_id` da ocupação', async () => {
    const r = await reserva('06:00', '07:00');
    const acoes = await acoesDaEmpresa();

    await courts.moveBooking(
      EMPRESA,
      r,
      { horaInicio: '21:00', horaFim: '22:00' },
      UADMIN,
    );

    const depois = await linha(r);
    expect(await acoesDaEmpresa()).toBe(acoes + 1);
    expect(await rastro(r)).toEqual([
      {
        evento: 'movida',
        acao: 'reserva_movida',
        motivo: null,
        transicao_id: depois.transicao_id,
      },
    ]);
    expect(depois.transicao_id).not.toBeNull();
  });
});

/**
 * SPEC-054/TASK-004 — **reservar com adicional, por HTTP, contra a aplicação e
 * o banco reais.** O dinheiro (débito, saldo, devolução) e o estoque (a trigger)
 * são o que se julga, e nenhum dos dois se prova com dublê.
 *
 * Escrito ANTES da implementação, e visto vermelho (CLI_AUDIT).
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { comAcao } from '../banco/acao-com-efeito';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import { dataFutura, idsDoCenario, login, montarCenario } from './cenario';

const C = idsDoCenario(8);
const OUTRA = idsDoCenario(9);

jest.setTimeout(240_000);

exigirBancoLocal();

const db = new PrismaClient();
let app: INestApplication<App>;
let gestor: string;
let aluno1: string;

/** Quadra a R$ 80/h no cenário; aula particular a R$ 120 no professor. */
const PRECO_HORA = 80;
const PRECO_AULA = 120;
const DATA = dataFutura(21);

const PROF = 'f0430008-0000-4000-8000-0000000000a1';
const TIPO = 'f0430008-0000-4000-8000-0000000000a2';
const RAQUETE = 'f0430008-0000-4000-8000-0000000000a3'; // R$ 15, estoque 2
const BOLA = 'f0430008-0000-4000-8000-0000000000a4'; // R$ 5, estoque 10
const INATIVO = 'f0430008-0000-4000-8000-0000000000a5';
const TIPO_ALHEIO = 'f0430009-0000-4000-8000-0000000000a2';
const ALHEIO = 'f0430009-0000-4000-8000-0000000000a3';

const api = () => request(app.getHttpServer());

interface Item {
  adicionalId: string;
  nome: string;
  quantidade: number;
  valorUnitario: number;
}
interface Reserva {
  id: string;
  valor: number;
  statusPagamento: string;
  horaInicio: string;
  adicionais: Item[];
}

function reservar(
  token: string,
  corpo: Record<string, unknown>,
  chave?: string,
) {
  const r = api()
    .post('/api/v1/bookings')
    .set('Authorization', `Bearer ${token}`);
  if (chave) r.set('Idempotency-Key', chave);
  return r.send({
    quadraId: C.QUADRA,
    data: DATA,
    alunoId: C.ALUNO1,
    ...corpo,
  });
}

const slot = (horaInicio: string, horaFim: string) => ({ horaInicio, horaFim });

async function contar(sql: string): Promise<number> {
  const [l] = await db.$queryRawUnsafe<{ n: bigint }[]>(sql);
  return Number(l.n);
}
const ocupacoes = () =>
  contar(
    `SELECT count(*) AS n FROM ocupacoes_quadra WHERE company_id='${C.EMPRESA}'`,
  );
const movimentos = () =>
  contar(
    `SELECT count(*) AS n FROM movimentos_de_credito WHERE company_id='${C.EMPRESA}' AND tipo <> 'entrada'`,
  );

/** Crédito pela porta do ledger — a única (SPEC-033/INV-071). */
async function creditar(centavos: number): Promise<void> {
  // SPEC-069/INV-069a — a acao e o movimento na MESMA transacao. Os dois
  // statements em autocommit eram duas transacoes, e o `acao_exige_alvo`
  // recusa a primeira delas no COMMIT.
  await comAcao(
    db,
    {
      companyId: C.EMPRESA,
      tipo: 'credito_lancado',
      autorId: C.ADMIN_USUARIO,
    },
    (tx, acaoId) =>
      tx.$executeRawUnsafe(
        `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
         VALUES (gen_random_uuid(),'${C.EMPRESA}','${C.ALUNO1}','entrada',${centavos},'aporte 054','${C.ADMIN_USUARIO}','${acaoId}')`,
      ),
  );
}

async function semearCatalogo(): Promise<void> {
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  const diaSemana = new Date(`${DATA}T12:00:00Z`).getUTCDay();
  await q(
    `INSERT INTO professores (id,company_id,nome,status,preco_aula) VALUES ('${PROF}','${C.EMPRESA}','Prof 054','ativo',${PRECO_AULA})`,
  );
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${C.EMPRESA}','${PROF}',${diaSemana},'06:00','22:00',now())`,
  );
  await q(
    `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES ('${TIPO}','${C.EMPRESA}','Raquetes'),('${TIPO_ALHEIO}','${OUTRA.EMPRESA}','Raquetes')`,
  );
  await q(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,ativo,updated_at) VALUES
      ('${RAQUETE}','${C.EMPRESA}','${TIPO}','Raquete',15,2,true,now()),
      ('${BOLA}','${C.EMPRESA}','${TIPO}','Bola',5,10,true,now()),
      ('${INATIVO}','${C.EMPRESA}','${TIPO}','Bola velha',5,10,false,now()),
      ('${ALHEIO}','${OUTRA.EMPRESA}','${TIPO_ALHEIO}','Raquete',15,10,true,now())`,
  );
}

async function recriarCenario(): Promise<void> {
  for (const ids of [C, OUTRA]) {
    await limparEmpresa(db, ids.EMPRESA);
    await montarCenario(db, ids);
  }
  await semearCatalogo();
}

beforeAll(async () => {
  app = await subirAppReal();
  await recriarCenario();
  // Login UMA vez: por teste, o limite de tentativas de login responde 429. O
  // guard não compara `iat` com o usuário, e o cenário recria os usuários com
  // os MESMOS ids — o token segue valendo depois de `recriarCenario`.
  gestor = (await login(app, C.ADMIN_EMAIL)).accessToken;
  aluno1 = (await login(app, C.ALUNO1_EMAIL)).accessToken;
});

beforeEach(recriarCenario);

afterAll(async () => {
  await app?.close();
  for (const ids of [C, OUTRA]) {
    await limparEmpresa(db, ids.EMPRESA);
  }
  await db.$disconnect();
});

const corpoDe = (r: request.Response) => r.body as { reservas: Reserva[] };

describe('SPEC-054/REQ-002 — o adicional entra no valor da reserva', () => {
  it('AC-007: quadra 9h–11h com 2 raquetes de R$ 15 → valor = preço × 2h + 30, e o item na resposta', async () => {
    const r = await reservar(gestor, {
      slots: [slot('09:00', '10:00'), slot('10:00', '11:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    const [reserva] = corpoDe(r).reservas;
    expect(reserva.valor).toBe(PRECO_HORA * 2 + 30);
    expect(reserva.adicionais).toEqual([
      {
        adicionalId: RAQUETE,
        nome: 'Raquete',
        quantidade: 2,
        valorUnitario: 15,
      },
    ]);
  });

  it('D12: o item aparece no dia da agenda do gestor', async () => {
    await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    const dia = await api()
      .get(`/api/v1/agenda/${DATA}`)
      .set('Authorization', `Bearer ${gestor}`)
      .expect(200);
    // `GET /agenda/:data` devolve a LISTA de itens do dia, não `{ itens }`.
    const itens = dia.body as { adicionais: Item[] }[];
    expect(itens).toHaveLength(1);
    expect(itens[0].adicionais).toEqual([
      {
        adicionalId: RAQUETE,
        nome: 'Raquete',
        quantidade: 2,
        valorUnitario: 15,
      },
    ]);
  });

  it('AC-008: aula particular com 2 raquetes → valor = preço da aula + 30', async () => {
    const r = await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      professorId: PROF,
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    expect(corpoDe(r).reservas[0].valor).toBe(PRECO_AULA + 30);
  });

  it('AC-009: blocos 9h e 15h com 1 bola → DUAS reservas, cada uma com o item e com o valor dele', async () => {
    const r = await reservar(gestor, {
      slots: [slot('09:00', '10:00'), slot('15:00', '16:00')],
      adicionais: [{ adicionalId: BOLA, quantidade: 1 }],
    }).expect(201);
    const reservas = corpoDe(r).reservas;
    expect(reservas).toHaveLength(2);
    for (const reserva of reservas) {
      expect(reserva.valor).toBe(PRECO_HORA + 5);
      expect(reserva.adicionais).toEqual([
        { adicionalId: BOLA, nome: 'Bola', quantidade: 1, valorUnitario: 5 },
      ]);
    }
  });

  it('AC-010: repetido → 422 ADICIONAL_REPETIDO; inexistente e de OUTRA empresa → 404 iguais; inativo → 422 ADICIONAL_INATIVO', async () => {
    const casos: [unknown[], number, string][] = [
      [
        [
          { adicionalId: BOLA, quantidade: 1 },
          { adicionalId: BOLA, quantidade: 2 },
        ],
        422,
        'ADICIONAL_REPETIDO',
      ],
      [
        [
          {
            adicionalId: 'f0430008-0000-4000-8000-0000000000ff',
            quantidade: 1,
          },
        ],
        404,
        'ADICIONAL_NAO_ENCONTRADO',
      ],
      [
        [{ adicionalId: ALHEIO, quantidade: 1 }],
        404,
        'ADICIONAL_NAO_ENCONTRADO',
      ],
      [[{ adicionalId: INATIVO, quantidade: 1 }], 422, 'ADICIONAL_INATIVO'],
    ];
    for (const [adicionais, status, code] of casos) {
      const r = await reservar(gestor, {
        slots: [slot('09:00', '10:00')],
        adicionais,
      });
      expect({
        status: r.status,
        code: (r.body as { code?: string }).code,
      }).toEqual({
        status,
        code,
      });
    }
    expect(await ocupacoes()).toBe(0);
  });

  it('AC-011: mudar o preço do adicional depois NÃO muda o valor nem o valorUnitario da reserva feita', async () => {
    await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(201);
    await api()
      .patch(`/api/v1/adicionais/${RAQUETE}`)
      .set('Authorization', `Bearer ${gestor}`)
      .send({ preco: 99 })
      .expect(200);
    const lista = await api()
      .get(`/api/v1/bookings?data=${DATA}`)
      .set('Authorization', `Bearer ${gestor}`)
      .expect(200);
    const [reserva] = (lista.body as { data: Reserva[] }).data;
    expect(reserva.valor).toBe(PRECO_HORA + 15);
    expect(reserva.adicionais[0].valorUnitario).toBe(15);
  });

  it('AC-012: mesma chave, mesmos horários, adicionais diferentes → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const chave = 'spec054-ac012';
    await reservar(
      gestor,
      {
        slots: [slot('09:00', '10:00')],
        adicionais: [{ adicionalId: BOLA, quantidade: 1 }],
      },
      chave,
    ).expect(201);
    const r = await reservar(
      gestor,
      {
        slots: [slot('09:00', '10:00')],
        adicionais: [{ adicionalId: BOLA, quantidade: 2 }],
      },
      chave,
    );
    expect({
      status: r.status,
      code: (r.body as { code?: string }).code,
    }).toEqual({
      status: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('AC-013: gestor com valor digitado na aula + adicional → digitado + adicional; com valor 0 → só o adicional', async () => {
    const digitado = await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      professorId: PROF,
      valor: 50,
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(201);
    expect(corpoDe(digitado).reservas[0].valor).toBe(65);

    const cortesia = await reservar(gestor, {
      slots: [slot('11:00', '12:00')],
      professorId: PROF,
      valor: 0,
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(201);
    expect(corpoDe(cortesia).reservas[0].valor).toBe(15);
  });

  it('AC-034: a chave gravada SEM adicional tem a impressão de antes da Entrega B, e o replay devolve o original sem ocupação nem movimento novos — também com `adicionais: []`', async () => {
    const chave = 'spec054-ac034';
    const primeira = await reservar(
      gestor,
      { slots: [slot('09:00', '10:00')] },
      chave,
    ).expect(201);
    const [{ fingerprint }] = await db.$queryRawUnsafe<
      { fingerprint: string }[]
    >(
      `SELECT fingerprint FROM pedidos_reserva WHERE company_id='${C.EMPRESA}' AND client_request_id='${chave}'`,
    );
    // O formato de `origin/main` antes da SPEC-054, literal.
    expect(fingerprint).toBe(`${C.QUADRA}|${DATA}|09:00-10:00`);
    const [o0, m0] = [await ocupacoes(), await movimentos()];

    for (const corpo of [
      { slots: [slot('09:00', '10:00')] },
      { slots: [slot('09:00', '10:00')], adicionais: [] },
    ]) {
      const replay = await reservar(gestor, corpo, chave).expect(201);
      expect(corpoDe(replay).reservas.map((x) => x.id)).toEqual(
        corpoDe(primeira).reservas.map((x) => x.id),
      );
    }
    expect([await ocupacoes(), await movimentos()]).toEqual([o0, m0]);
  });
});

describe('SPEC-054/REQ-003 — o estoque é respeitado', () => {
  it('AC-014 e AC-015: 2 raquetes às 9h–10h numa quadra; às 9h30 na OUTRA quadra com 1 → 409 ESTOQUE_ESGOTADO, disponivel 0; às 10h–11h com 2 → 201', async () => {
    await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);

    const recusa = await reservar(gestor, {
      quadraId: C.QUADRA_TURMAS,
      slots: [slot('09:30', '10:30')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    });
    expect({ status: recusa.status, body: recusa.body as unknown }).toEqual({
      status: 409,
      body: expect.objectContaining({
        code: 'ESTOQUE_ESGOTADO',
        adicionalId: RAQUETE,
        disponivel: 0,
      }) as unknown,
    });

    await reservar(gestor, {
      quadraId: C.QUADRA_TURMAS,
      slots: [slot('10:00', '11:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
  });

  it('AC-016: cancelar a reserva devolve a unidade — a mesma tentativa passa a 201', async () => {
    const r = await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    const tentativa = () =>
      reservar(gestor, {
        quadraId: C.QUADRA_TURMAS,
        slots: [slot('09:30', '10:30')],
        adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
      });
    await tentativa().expect(409);
    await api()
      .post(`/api/v1/bookings/${corpoDe(r).reservas[0].id}/cancel`)
      .set('Authorization', `Bearer ${gestor}`)
      .expect(200);
    await tentativa().expect(201);
  });

  it('AC-017: dois blocos em que só o segundo não tem estoque → 409, NENHUMA ocupação criada, NENHUM débito', async () => {
    await creditar(100_000);
    await reservar(gestor, {
      quadraId: C.QUADRA_TURMAS,
      slots: [slot('15:00', '16:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    const [o0, m0] = [await ocupacoes(), await movimentos()];

    await reservar(aluno1, {
      slots: [slot('09:00', '10:00'), slot('15:00', '16:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(409);

    expect([await ocupacoes(), await movimentos()]).toEqual([o0, m0]);
  });

  it('AC-019: mover reserva com adicional para horário sem estoque → 409 ESTOQUE_ESGOTADO, e ela fica onde estava', async () => {
    await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 2 }],
    }).expect(201);
    const outra = await reservar(gestor, {
      quadraId: C.QUADRA_TURMAS,
      slots: [slot('13:00', '14:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(201);
    const id = corpoDe(outra).reservas[0].id;

    const r = await api()
      .patch(`/api/v1/bookings/${id}`)
      .set('Authorization', `Bearer ${gestor}`)
      .send({ horaInicio: '09:30', horaFim: '10:30' });
    expect({
      status: r.status,
      code: (r.body as { code?: string }).code,
    }).toEqual({
      status: 409,
      code: 'ESTOQUE_ESGOTADO',
    });
    const [l] = await db.$queryRawUnsafe<{ inicio: string }[]>(
      `SELECT to_char(hora_inicio,'HH24:MI') AS inicio FROM ocupacoes_quadra WHERE id='${id}'`,
    );
    expect(l.inicio).toBe('13:00');
  });
});

describe('SPEC-054/REQ-004 — o dinheiro fecha', () => {
  it('AC-021: saldo para a quadra e SEM saldo para quadra + adicional → 422 SALDO_INSUFICIENTE com faltamCentavos contando o adicional', async () => {
    await creditar(PRECO_HORA * 100);
    const r = await reservar(aluno1, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    });
    expect({ status: r.status, body: r.body as unknown }).toEqual({
      status: 422,
      body: expect.objectContaining({
        code: 'SALDO_INSUFICIENTE',
        faltamCentavos: 1500,
      }) as unknown,
    });
  });

  it('AC-022: cancelar reserva paga pela carteira devolve o valor INTEIRO, adicional incluído, num único movimento de devolução', async () => {
    await creditar(20_000);
    const r = await reservar(aluno1, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
    }).expect(201);
    const id = corpoDe(r).reservas[0].id;
    await api()
      .post(`/api/v1/bookings/${id}/cancel`)
      .set('Authorization', `Bearer ${aluno1}`)
      .expect(200);
    const devolucoes = await db.$queryRawUnsafe<{ valor_centavos: number }[]>(
      `SELECT valor_centavos FROM movimentos_de_credito WHERE ocupacao_id='${id}' AND tipo='devolucao'`,
    );
    expect(devolucoes).toEqual([{ valor_centavos: (PRECO_HORA + 15) * 100 }]);
  });

  it('AC-023: gestor sem saldo do aluno → pendente_pagamento com o valor somado; dar baixa não gera movimento', async () => {
    const r = await reservar(gestor, {
      slots: [slot('09:00', '10:00')],
      adicionais: [{ adicionalId: BOLA, quantidade: 2 }],
    }).expect(201);
    const [reserva] = corpoDe(r).reservas;
    expect(reserva).toMatchObject({
      statusPagamento: 'pendente_pagamento',
      valor: PRECO_HORA + 10,
    });
    const m0 = await movimentos();
    await api()
      .patch(`/api/v1/bookings/${reserva.id}/payment-status`)
      .set('Authorization', `Bearer ${gestor}`)
      .send({ status: 'pago' })
      .expect(200);
    expect(await movimentos()).toBe(m0);
  });
});

describe('SPEC-054/AC-038 — o 23514 de TRIGGER de item, na criação, não é VALOR_INVALIDO', () => {
  it('uma trigger de teste que recusa o item com 23514 → 500, nunca 400', async () => {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION teste_054_item_recusado() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'recusa de teste do item' USING ERRCODE = '23514';
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER teste_054_item_recusado BEFORE INSERT ON adicionais_da_ocupacao
      FOR EACH ROW WHEN (NEW.company_id = '${C.EMPRESA}'::uuid)
      EXECUTE FUNCTION teste_054_item_recusado()`);
    try {
      const r = await reservar(gestor, {
        slots: [slot('09:00', '10:00')],
        adicionais: [{ adicionalId: BOLA, quantidade: 1 }],
      });
      expect(r.status).toBe(500);
      expect(await ocupacoes()).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS teste_054_item_recusado ON adicionais_da_ocupacao`,
      );
      await db.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS teste_054_item_recusado()`,
      );
    }
  });
});

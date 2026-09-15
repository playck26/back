/**
 * SPEC-054/FIT-046 — **a concorrência do estoque de adicionais, por HTTP, com
 * duas pools.**
 *
 * INV-133: no momento em que uma unidade é tomada, o reservado sobreposto cabe no
 * estoque. Quem garante é a trigger `adicional_cabe_no_estoque` (`FOR UPDATE` no
 * adicional + soma em instrução separada); a trava 2b da aplicação dá ORDEM.
 * Aqui se prova o efeito sob corrida real, pelos caminhos de produção:
 *
 *   (a) duas reservas simultâneas em quadras diferentes, mesmo horário, pela
 *       última unidade → um 201, um 409; soma ≤ estoque; a recusada sem
 *       ocupação e sem movimento;
 *   (b) criar com o adicional × mover outra reserva com o mesmo adicional para o
 *       mesmo horário → um sucesso, um 409;
 *   (c) cancelar × criar pela última unidade → nunca soma acima do estoque;
 *   (d) duas reservas com os adicionais A e B pedidos em ordens opostas → as
 *       duas 201, nenhum 40P01, nenhum 500;
 *   (e) pedido de dois blocos, o segundo sem estoque, concorrente com a reserva
 *       que esgota → nenhuma ocupação parcial, nenhum débito.
 *
 * Cada par vai para um app diferente, cada um com a própria pool (FIT-001). Cada
 * iteração usa uma data própria: nenhuma herda o estado da anterior.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  dataFutura,
  idsDoCenario,
  login,
  montarCenario,
  type Sessao,
} from './cenario';

const C = idsDoCenario(6);

jest.setTimeout(900_000);
exigirBancoLocal();

const db = new PrismaClient();
let appA: INestApplication<App>;
let appB: INestApplication<App>;
let gestor: Sessao;
let aluno1: Sessao;
let aluno2: Sessao;

const ITERACOES = 8;

const TIPO = 'f0430006-0000-4000-8000-0000000000b1';
/** Estoque 1 — a última unidade de (a), (b), (c) e (e). */
const RAQUETE = 'f0430006-0000-4000-8000-0000000000b2';
/** Estoque 2 cada — os dois de (d). */
const ADIC_A = 'f0430006-0000-4000-8000-0000000000b3';
const ADIC_B = 'f0430006-0000-4000-8000-0000000000b4';

function post(
  app: INestApplication<App>,
  rota: string,
  s: Sessao,
  corpo?: object,
) {
  const r = request(app.getHttpServer())
    .post(rota)
    .set('Authorization', `Bearer ${s.accessToken}`);
  return corpo === undefined ? r : r.send(corpo);
}

function reservar(
  app: INestApplication<App>,
  s: Sessao,
  corpo: {
    quadraId: string;
    data: string;
    slots: { horaInicio: string; horaFim: string }[];
    alunoId: string;
    adicionais: { adicionalId: string; quantidade: number }[];
  },
) {
  return post(app, '/api/v1/bookings', s, corpo);
}

const s = (horaInicio: string, horaFim: string) => ({ horaInicio, horaFim });

/** Respostas fora do esperado, com corpo: um 500 sem corpo custa um ciclo de CI. */
function detalhe(...respostas: { status: number; text: string }[]): string {
  return respostas
    .filter((r) => ![200, 201, 409].includes(r.status))
    .map((r) => ` [${r.status}: ${r.text.slice(0, 300)}]`)
    .join('');
}

async function numero(sql: string): Promise<number> {
  const [l] = await db.$queryRawUnsafe<{ n: bigint | number }[]>(sql);
  return Number(l.n);
}

/** Unidades do adicional tomadas por reservas NÃO canceladas que se sobrepõem ao intervalo. */
function tomadas(
  adicionalId: string,
  data: string,
  inicio: string,
  fim: string,
) {
  return numero(`
    SELECT coalesce(sum(i.quantidade), 0) AS n
      FROM adicionais_da_ocupacao i
      JOIN ocupacoes_quadra o ON o.company_id = i.company_id AND o.id = i.ocupacao_id
     WHERE i.adicional_id = '${adicionalId}'
       AND o.status_pagamento <> 'cancelado'
       AND tsrange(o.data + o.hora_inicio, o.data + o.hora_fim)
        && tsrange('${data}'::date + '${inicio}'::time, '${data}'::date + '${fim}'::time)`);
}

const ocupacoesDoAluno = (alunoId: string, data: string) =>
  numero(
    `SELECT count(*) AS n FROM ocupacoes_quadra WHERE aluno_id='${alunoId}' AND data='${data}'::date`,
  );

const consumosDoAluno = (alunoId: string, data: string) =>
  numero(
    `SELECT count(*) AS n FROM movimentos_de_credito m JOIN ocupacoes_quadra o ON o.id = m.ocupacao_id
      WHERE m.aluno_id='${alunoId}' AND m.tipo='consumo' AND o.data='${data}'::date`,
  );

async function creditar(alunoId: string, centavos: number): Promise<void> {
  const [acao] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${C.EMPRESA}','credito_lancado','${C.ADMIN_USUARIO}') RETURNING id`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
     VALUES (gen_random_uuid(),'${C.EMPRESA}','${alunoId}','entrada',${centavos},'FIT-046','${C.ADMIN_USUARIO}','${acao.id}')`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  await db.$executeRawUnsafe(
    `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES ('${TIPO}','${C.EMPRESA}','Raquetes')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at) VALUES
      ('${RAQUETE}','${C.EMPRESA}','${TIPO}','Raquete',15,1,now()),
      ('${ADIC_A}','${C.EMPRESA}','${TIPO}','Bola A',5,2,now()),
      ('${ADIC_B}','${C.EMPRESA}','${TIPO}','Bola B',5,2,now())`,
  );
  await creditar(C.ALUNO1, 10_000_000);
  await creditar(C.ALUNO2, 10_000_000);
  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
  gestor = await login(appA, C.ADMIN_EMAIL);
  aluno1 = await login(appA, C.ALUNO1_EMAIL);
  aluno2 = await login(appB, C.ALUNO2_EMAIL);
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

describe('FIT-046 (a) — duas reservas simultâneas pela última unidade, em quadras diferentes', () => {
  it(`${ITERACOES} pares: exatamente 201/409, soma ≤ estoque, a recusada sem ocupação e sem movimento`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(60 + i);
      const [r1, r2] = await Promise.all([
        reservar(appA, aluno1, {
          quadraId: C.QUADRA,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO1,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
        reservar(appB, aluno2, {
          quadraId: C.QUADRA_TURMAS,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO2,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
      ]);
      const par = [r1.status, r2.status].sort();
      const soma = await tomadas(RAQUETE, data, '10:00', '11:00');
      const perdedor = r1.status === 409 ? C.ALUNO1 : C.ALUNO2;
      const [ocPerdedor, consPerdedor] = [
        await ocupacoesDoAluno(perdedor, data),
        await consumosDoAluno(perdedor, data),
      ];
      if (
        par[0] !== 201 ||
        par[1] !== 409 ||
        soma !== 1 ||
        ocPerdedor !== 0 ||
        consPerdedor !== 0
      ) {
        falhas.push(
          `iteração ${i + 1}: ${r1.status}/${r2.status}, soma=${soma}, recusada: ocupações=${ocPerdedor} consumos=${consPerdedor}${detalhe(r1, r2)}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-046 (b) — criar com o adicional × mover outra reserva com ele para o mesmo horário', () => {
  it(`${ITERACOES} pares: um sucesso, um 409, e a soma nunca passa do estoque`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(80 + i);
      const existente = await reservar(appA, gestor, {
        quadraId: C.QUADRA_TURMAS,
        data,
        slots: [s('14:00', '15:00')],
        alunoId: C.ALUNO1,
        adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
      });
      if (existente.status !== 201) {
        falhas.push(
          `iteração ${i + 1}: preparo ${existente.status} ${existente.text.slice(0, 200)}`,
        );
        continue;
      }
      const id = (existente.body as { reservas: { id: string }[] }).reservas[0]
        .id;
      const [rCriar, rMover] = await Promise.all([
        reservar(appA, gestor, {
          quadraId: C.QUADRA,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO2,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
        request(appB.getHttpServer())
          .patch(`/api/v1/bookings/${id}`)
          .set('Authorization', `Bearer ${gestor.accessToken}`)
          .send({ horaInicio: '10:00', horaFim: '11:00' }),
      ]);
      const sucessos = [rCriar.status === 201, rMover.status === 200].filter(
        Boolean,
      ).length;
      const recusas = [rCriar.status, rMover.status].filter(
        (x) => x === 409,
      ).length;
      const soma = await tomadas(RAQUETE, data, '10:00', '11:00');
      if (sucessos !== 1 || recusas !== 1 || soma > 1) {
        falhas.push(
          `iteração ${i + 1}: criar=${rCriar.status} mover=${rMover.status}, soma=${soma}${detalhe(rCriar, rMover)}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-046 (c) — cancelar × criar pela última unidade', () => {
  it(`${ITERACOES} pares: nunca soma acima do estoque, e nunca 500`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(100 + i);
      const existente = await reservar(appA, gestor, {
        quadraId: C.QUADRA,
        data,
        slots: [s('10:00', '11:00')],
        alunoId: C.ALUNO1,
        adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
      });
      if (existente.status !== 201) {
        falhas.push(`iteração ${i + 1}: preparo ${existente.status}`);
        continue;
      }
      const id = (existente.body as { reservas: { id: string }[] }).reservas[0]
        .id;
      const [rCancelar, rCriar] = await Promise.all([
        post(appA, `/api/v1/bookings/${id}/cancel`, gestor),
        reservar(appB, gestor, {
          quadraId: C.QUADRA_TURMAS,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO2,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
      ]);
      const soma = await tomadas(RAQUETE, data, '10:00', '11:00');
      // A criação pode perder por excesso de CAUTELA (viu a unidade ainda tomada),
      // nunca por excesso de unidades.
      if (
        rCancelar.status !== 200 ||
        ![201, 409].includes(rCriar.status) ||
        soma > 1
      ) {
        falhas.push(
          `iteração ${i + 1}: cancelar=${rCancelar.status} criar=${rCriar.status}, soma=${soma}${detalhe(rCancelar, rCriar)}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-046 (d) — adicionais A e B pedidos em ordens opostas', () => {
  it(`${ITERACOES} pares: as duas 201, nenhum 40P01, nenhum 500`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(120 + i);
      const [r1, r2] = await Promise.all([
        reservar(appA, gestor, {
          quadraId: C.QUADRA,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO1,
          adicionais: [
            { adicionalId: ADIC_A, quantidade: 1 },
            { adicionalId: ADIC_B, quantidade: 1 },
          ],
        }),
        reservar(appB, gestor, {
          quadraId: C.QUADRA_TURMAS,
          data,
          slots: [s('10:00', '11:00')],
          alunoId: C.ALUNO2,
          adicionais: [
            { adicionalId: ADIC_B, quantidade: 1 },
            { adicionalId: ADIC_A, quantidade: 1 },
          ],
        }),
      ]);
      if (r1.status !== 201 || r2.status !== 201) {
        falhas.push(
          `iteração ${i + 1}: ${r1.status}/${r2.status}${detalhe(r1, r2)}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-046 (e) — dois blocos, o segundo sem estoque, contra a reserva que esgota', () => {
  it(`${ITERACOES} pares: o pedido entra inteiro ou nada — nenhuma ocupação parcial, nenhum débito parcial`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(140 + i);
      const [rPedido, rEsgota] = await Promise.all([
        reservar(appA, aluno1, {
          quadraId: C.QUADRA,
          data,
          slots: [s('09:00', '10:00'), s('15:00', '16:00')],
          alunoId: C.ALUNO1,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
        reservar(appB, aluno2, {
          quadraId: C.QUADRA_TURMAS,
          data,
          slots: [s('15:00', '16:00')],
          alunoId: C.ALUNO2,
          adicionais: [{ adicionalId: RAQUETE, quantidade: 1 }],
        }),
      ]);
      const [oc, cons] = [
        await ocupacoesDoAluno(C.ALUNO1, data),
        await consumosDoAluno(C.ALUNO1, data),
      ];
      const soma = await tomadas(RAQUETE, data, '15:00', '16:00');
      const inteiro = rPedido.status === 201 && oc === 2 && cons === 2;
      const nada = rPedido.status === 409 && oc === 0 && cons === 0;
      if (
        !(inteiro || nada) ||
        soma > 1 ||
        ![201, 409].includes(rEsgota.status)
      ) {
        falhas.push(
          `iteração ${i + 1}: pedido=${rPedido.status} (ocupações=${oc}, consumos=${cons}) esgota=${rEsgota.status}, soma=${soma}${detalhe(rPedido, rEsgota)}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

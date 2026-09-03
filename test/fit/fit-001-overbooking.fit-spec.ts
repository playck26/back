/**
 * SPEC-043 — **FIT-001 como check de PR: quatro cenários, HTTP real, duas
 * pools.**
 *
 * O FIT-001 original (bash + curl no `db-migrate.yml`) provava UM cenário —
 * duas criações AVULSO do mesmo slot — e ficou 26 dias sem rodar. A
 * auditoria externa de 2026-09-03 mostrou que ele não cobria os riscos que
 * as SPECs 011, 019, 032 e 042 introduziram. Este arquivo cobre os quatro:
 *
 *   (a) mesmo slot, AVULSO, admin — INV-001, o original;
 *   (b) pedido com múltiplos blocos e conflito PARCIAL — SPEC-011: ou o
 *       pedido entra inteiro, ou não deixa linha nenhuma;
 *   (c) duas turmas com `encontros[]` e conflito em UM dia — SPEC-019: a
 *       linha da tabela de provas que nunca rodou;
 *   (d) cancelar × re-reservar o mesmo slot, pelos três caminhos de
 *       cancelamento — SPEC-032/INV-064 (evento da transição) e SPEC-042.
 *
 * Cada par de requisições vai para um app diferente (`appA`/`appB`), cada
 * um com a própria pool — pelo mesmo motivo que o FIT-010 abre dois
 * `PrismaClient`. E cada iteração usa data ou hora própria: uma iteração
 * não pode herdar o estado da anterior e passar (ou cair) por ele.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  ADMIN_EMAIL,
  ALUNO1,
  ALUNO1_EMAIL,
  ALUNO2,
  EMPRESA,
  QUADRA,
  QUADRA_TURMAS,
  ativasNoSlot,
  dataFutura,
  eventoDeCancelamento,
  login,
  montarCenario,
  ocorrenciasDaTurma,
  ocupacao,
  turmasComNome,
  type Sessao,
} from './cenario';

jest.setTimeout(600_000);
exigirBancoLocal();

const db = new PrismaClient();
let appA: INestApplication<App>;
let appB: INestApplication<App>;
let admin: Sessao;
let aluno1: Sessao;

const ITERACOES_A = 20;
const ITERACOES = 10;

function codigos(...respostas: { status: number }[]): number[] {
  return respostas.map((r) => r.status).sort((x, y) => x - y);
}

function post(
  app: INestApplication<App>,
  rota: string,
  token: string,
  corpo?: object,
) {
  const req = request(app.getHttpServer())
    .post(rota)
    .set('Authorization', `Bearer ${token}`);
  return corpo === undefined ? req : req.send(corpo);
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await montarCenario(db);
  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
  admin = await login(appA, ADMIN_EMAIL);
  aluno1 = await login(appB, ALUNO1_EMAIL);
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-001 (a) — duas criações AVULSO do mesmo slot', () => {
  it(`${ITERACOES_A} pares: cada par exatamente 201/409, uma ocupação ativa no slot`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES_A; i++) {
      const data = dataFutura(40 + i);
      const corpo = {
        quadraId: QUADRA,
        data,
        horaInicio: '10:00',
        horaFim: '11:00',
        alunoId: ALUNO1,
      };
      const [r1, r2] = await Promise.all([
        post(appA, '/api/v1/bookings', admin.accessToken, corpo),
        post(appB, '/api/v1/bookings', admin.accessToken, corpo),
      ]);
      const ativas = await ativasNoSlot(db, QUADRA, data, '10:00');
      const par = codigos(r1, r2);
      if (par[0] !== 201 || par[1] !== 409 || ativas !== 1) {
        falhas.push(
          `iteração ${i + 1}: ${r1.status}/${r2.status}, ativas=${ativas}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-001 (b) — pedido de múltiplos blocos com conflito parcial (SPEC-011)', () => {
  it(`${ITERACOES} pares: o pedido entra inteiro ou não deixa linha nenhuma`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const data = dataFutura(70 + i);
      const pedido = {
        quadraId: QUADRA,
        data,
        // NÃO contíguos, de propósito: a SPEC-011 funde blocos contíguos numa
        // ocupação só (10–11 + 11–12 = uma linha 10–12), e aí "linha parcial"
        // não existe para ser provada. Com 10–11 e 12–13 o pedido são DUAS
        // linhas, e é a segunda que não pode sobrar quando ele perde.
        slots: [
          { horaInicio: '10:00', horaFim: '11:00' },
          { horaInicio: '12:00', horaFim: '13:00' },
        ],
        alunoId: ALUNO1,
      };
      const avulsa = {
        quadraId: QUADRA,
        data,
        horaInicio: '12:00',
        horaFim: '13:00',
        alunoId: ALUNO2,
      };
      const [rPedido, rAvulsa] = await Promise.all([
        post(appA, '/api/v1/bookings', admin.accessToken, pedido),
        post(appB, '/api/v1/bookings', admin.accessToken, avulsa),
      ]);
      const par = codigos(rPedido, rAvulsa);
      const bloco1 = await ativasNoSlot(db, QUADRA, data, '10:00');
      const bloco2 = await ativasNoSlot(db, QUADRA, data, '12:00');
      // O slot disputado (12–13) tem exatamente uma ocupação, sempre. O
      // bloco não disputado (10–11) só existe se o PEDIDO venceu — uma linha
      // órfã do pedido perdedor é o defeito que este cenário existe para pegar.
      const esperadoBloco1 = rPedido.status === 201 ? 1 : 0;
      if (
        par[0] !== 201 ||
        par[1] !== 409 ||
        bloco2 !== 1 ||
        bloco1 !== esperadoBloco1
      ) {
        falhas.push(
          `iteração ${i + 1}: pedido=${rPedido.status} avulsa=${rAvulsa.status} bloco10-11=${bloco1} (esperado ${esperadoBloco1}) bloco12-13=${bloco2}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-001 (c) — duas turmas com `encontros[]` e conflito em um dia só (SPEC-019)', () => {
  it(`${ITERACOES} pares: uma vence com todas as ocorrências, a outra não deixa turma nem ocorrência`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      // Hora própria por iteração: a vencedora da iteração anterior ocupa os
      // dias dela em todas as semanas futuras; na mesma hora, as duas turmas
      // seguintes cairiam por ELA, e o par 409/409 diria nada.
      const h = 8 + i;
      const hora = (x: number) => `${String(x).padStart(2, '0')}:00`;
      const encontro = (diaSemana: number) => ({
        diaSemana,
        horaInicio: hora(h),
        horaFim: hora(h + 1),
      });
      const nome1 = `FIT-043 T1 ${i + 1}`;
      const nome2 = `FIT-043 T2 ${i + 1}`;
      const [r1, r2] = await Promise.all([
        post(appA, '/api/v1/classes', admin.accessToken, {
          nome: nome1,
          quadraId: QUADRA_TURMAS,
          encontros: [encontro(1), encontro(2)],
          capacidade: 4,
        }),
        post(appB, '/api/v1/classes', admin.accessToken, {
          nome: nome2,
          quadraId: QUADRA_TURMAS,
          encontros: [encontro(2), encontro(3)],
          capacidade: 4,
        }),
      ]);
      const par = codigos(r1, r2);
      const [vencedora, perdedora] =
        r1.status === 201 ? [nome1, nome2] : [nome2, nome1];
      const turmasPerdedora = await turmasComNome(db, perdedora);
      const ocorrenciasPerdedora = await ocorrenciasDaTurma(db, perdedora);
      const ocorrenciasVencedora = await ocorrenciasDaTurma(db, vencedora);
      if (
        par[0] !== 201 ||
        par[1] !== 409 ||
        turmasPerdedora !== 0 ||
        ocorrenciasPerdedora !== 0 ||
        ocorrenciasVencedora === 0
      ) {
        falhas.push(
          `iteração ${i + 1}: ${r1.status}/${r2.status}, perdedora: turmas=${turmasPerdedora} ocorrências=${ocorrenciasPerdedora}; vencedora: ocorrências=${ocorrenciasVencedora}`,
        );
      }
    }
    expect(falhas).toEqual([]);
  });
});

describe('FIT-001 (d) — cancelar × re-reservar o mesmo slot (SPEC-032/INV-064, SPEC-042)', () => {
  type Caminho = 'aluno cancela' | 'admin cancela' | 'admin marca cancelado';

  function cancelar(caminho: Caminho, app: INestApplication<App>, id: string) {
    switch (caminho) {
      case 'aluno cancela':
        return post(app, `/api/v1/bookings/${id}/cancel`, aluno1.accessToken);
      case 'admin cancela':
        return post(app, `/api/v1/bookings/${id}/cancel`, admin.accessToken);
      case 'admin marca cancelado':
        return request(app.getHttpServer())
          .patch(`/api/v1/bookings/${id}/payment-status`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ status: 'cancelado' });
    }
  }

  const caminhos: [Caminho, number, number][] = [
    ['aluno cancela', 204, 110],
    ['admin cancela', 204, 120],
    ['admin marca cancelado', 200, 130],
  ];

  it.each(caminhos)(
    `%s — ${ITERACOES} pares: no máximo uma ativa no slot, nunca 500, e cancelada tem evento da transição`,
    async (caminho, codigoCancel, baseDias) => {
      const falhas: string[] = [];
      for (let i = 0; i < ITERACOES; i++) {
        const data = dataFutura(baseDias + i);
        const criada = await post(appA, '/api/v1/bookings', admin.accessToken, {
          quadraId: QUADRA,
          data,
          horaInicio: '14:00',
          horaFim: '15:00',
          alunoId: ALUNO1,
        });
        if (criada.status !== 201) {
          falhas.push(
            `iteração ${i + 1}: setup devolveu ${criada.status}: ${criada.text}`,
          );
          continue;
        }
        const corpoCriada = criada.body as {
          reservas?: { id: string }[];
          id?: string;
        };
        const x = corpoCriada.reservas?.[0]?.id ?? corpoCriada.id ?? '';

        const [rCancel, rNova] = await Promise.all([
          cancelar(caminho, appA, x),
          post(appB, '/api/v1/bookings', admin.accessToken, {
            quadraId: QUADRA,
            data,
            horaInicio: '14:00',
            horaFim: '15:00',
            alunoId: ALUNO2,
          }),
        ]);

        const ativas = await ativasNoSlot(db, QUADRA, data, '14:00');
        const linhaX = await ocupacao(db, x);
        const cancelada = linhaX.status_pagamento === 'cancelado';
        const evento = cancelada
          ? await eventoDeCancelamento(db, x, linhaX.transicao_id ?? '')
          : 1;

        const problemas: string[] = [];
        if (rCancel.status !== codigoCancel)
          problemas.push(`cancel=${rCancel.status}`);
        if (rNova.status !== 201 && rNova.status !== 409)
          problemas.push(`nova=${rNova.status}`);
        if (ativas > 1) problemas.push(`ativas=${ativas}`);
        if (!cancelada) problemas.push(`X ficou ${linhaX.status_pagamento}`);
        if (evento !== 1)
          problemas.push('cancelada sem evento da transição (INV-064)');
        if (problemas.length) {
          falhas.push(`iteração ${i + 1}: ${problemas.join(', ')}`);
        }
      }
      expect(falhas).toEqual([]);
    },
  );
});

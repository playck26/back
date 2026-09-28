/**
 * SPEC-077/TASK-003 — **a sabotagem do AC-018 da SPEC-034, com o app REAL.**
 *
 * A 034 prometia: suprimir o `registrar` aborta o cancelamento com `23514`
 * (a trigger `ocupacao_cancelada_exige_evento`), **a transação inteira
 * reverte**, e a resposta é `500` estável, registrada em log com o id da
 * ocupação. A primeira frase tinha prova (o FIT-017, pelo banco); o resto era
 * `LACUNA`.
 *
 * **App real, e não dublê**: a garantia é uma `CONSTRAINT TRIGGER` diferida,
 * que só existe no Postgres, e o `500` é o do tratador de exceções do Nest —
 * dois lugares que um `createTestApp` com Prisma de mentira não tem.
 *
 * O `registrar` é espiado SEM efeito — o serviço acha que registrou, e o
 * banco é quem descobre que não. É o defeito que a trigger existe para pegar.
 */
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { RegistradorDeAcao } from '../../src/common/auditoria/registrador-de-acao';
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
import { primeiroNivelSql } from '../banco/nivel-da-fixture';

jest.setTimeout(120_000);

exigirBancoLocal();

/** A suíte 0 do cenário: 1 a 9 já têm dono. */
const C = idsDoCenario(0);
const UPROF = 'f0770341-0000-4000-8000-000000000001';
const PROF = 'f0770341-0000-4000-8000-000000000002';
const TURMA = 'f0770341-0000-4000-8000-000000000003';

const db = new PrismaClient();
let app: INestApplication<App>;
let gestor: Sessao;

/** `dias` à frente: a do caso sabotado continua ATIVA, e ocupa o horário. */
async function ocorrencia(dias: number): Promise<string> {
  const [{ id }] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES (gen_random_uuid(),'${C.EMPRESA}','${C.QUADRA_TURMAS}','${dataFutura(dias)}','10:00','11:00',
             'TURMA','${TURMA}','pendente_pagamento',now())
     RETURNING id::text`,
  );
  return id;
}

async function estado(ocupacao: string) {
  const [linha] = await db.$queryRawUnsafe<
    { status_pagamento: string; transicao_id: string | null }[]
  >(
    `SELECT status_pagamento::text, transicao_id::text FROM ocupacoes_quadra WHERE id = '${ocupacao}'`,
  );
  const [{ acoes }] = await db.$queryRawUnsafe<{ acoes: number }[]>(
    `SELECT count(*)::int AS acoes FROM acoes_administrativas WHERE company_id = '${C.EMPRESA}'`,
  );
  const [{ eventos }] = await db.$queryRawUnsafe<{ eventos: number }[]>(
    `SELECT count(*)::int AS eventos FROM eventos_de_ocupacao WHERE ocupacao_id = '${ocupacao}'`,
  );
  return { linha, acoes, eventos };
}

const cancelar = (ocupacao: string) =>
  request(app.getHttpServer())
    .post(`/api/v1/classes/${TURMA}/ocorrencias/${ocupacao}/cancel`)
    .set('Authorization', `Bearer ${gestor.accessToken}`)
    .send({ motivo: 'Quadra interditada' });

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  await db.$executeRawUnsafe(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UPROF}','prof-s077-034@teste.local','x','Prof','professor','${C.EMPRESA}',now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${C.EMPRESA}','Prof','${UPROF}')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,nivel_id)
     VALUES ('${TURMA}','${C.EMPRESA}','Turma SPEC-077','${C.QUADRA_TURMAS}','${PROF}',20,${primeiroNivelSql(`'${C.EMPRESA}'`)})`,
  );
  app = await subirAppReal();
  gestor = await login(app, C.ADMIN_EMAIL);
});

afterAll(async () => {
  await app?.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

describe('SPEC-077/AC-023 — cancelar sem registrar a ação (034 AC-018)', () => {
  it('#36: `500` nas DUAS tentativas, a ocorrência segue ativa, zero ações, e o log traz o id', async () => {
    const o = await ocorrencia(20);
    const antes = await estado(o);

    const registrar = jest
      .spyOn(RegistradorDeAcao.prototype, 'registrar')
      .mockResolvedValue(undefined);
    const logDeErro = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const respostas: number[] = [];
    let logado = '';
    try {
      for (let i = 0; i < 2; i += 1) {
        respostas.push((await cancelar(o)).status);
      }
      expect(registrar).toHaveBeenCalledTimes(2);
      logado = JSON.stringify(
        logDeErro.mock.calls.map((c) => c.map((x) => String(x))),
      );
    } finally {
      registrar.mockRestore();
      logDeErro.mockRestore();
    }

    // Estável: a segunda não vira `204` nem `409`, porque nada ficou gravado.
    expect(respostas).toEqual([500, 500]);
    // A transação INTEIRA voltou: nem o status, nem a transição, nem a ação.
    expect(await estado(o)).toEqual(antes);
    expect(antes.linha).toEqual({
      status_pagamento: 'pendente_pagamento',
      transicao_id: null,
    });
    expect(antes.eventos).toBe(0);
    // O log diz QUAL ocupação e POR QUÊ.
    expect(logado).toContain(o);
    expect(logado).toContain('cancelada sem evento');
  });

  it('controle: sem a sabotagem, o MESMO pedido passa — o `500` acima era dela', async () => {
    const o = await ocorrencia(21);
    const antes = await estado(o);

    expect((await cancelar(o)).status).toBe(204);

    const depois = await estado(o);
    expect(depois.linha.status_pagamento).toBe('cancelado');
    expect(depois.acoes).toBe(antes.acoes + 1);
    expect(depois.eventos).toBe(1);
  });
});

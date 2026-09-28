/**
 * SPEC-076/TASK-003 — **a chamada que ninguém marca, pelo app real e pela
 * rede** (AC-001, AC-003, e as rotas do "Desfazer" da D3).
 *
 * - **AC-001:** o `PUT /me/teacher/attendance/:id` com corpo válido, como o
 *   professor da turma, numa aula que o `PUT` antigo aceitaria, dá **404 do
 *   ROTEADOR** ("Cannot PUT"), e as linhas de `chamadas`/`presencas` saem
 *   idênticas — conteúdo, não contagem. Um handler que sobrasse e recusasse
 *   com 404 próprio não passaria na mensagem.
 * - **AC-003:** o `GET` continua respondendo ao professor da turma, com
 *   `status`, `faltaAvisada` e `desfazerNaoHouveAte`.
 * - **D3:** os dois `DELETE …/nao-houve` existem, com o guard de cada um.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  SENHA,
  login,
  montarCenario,
  type IdsDoCenario,
  type Sessao,
} from './cenario';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { primeiroNivelSql } from '../banco/nivel-da-fixture';

jest.setTimeout(600_000);
exigirBancoLocal();

const BASE = 'f0760000-0000-4000-8000-0000000000';
const C: IdsDoCenario = {
  EMPRESA: `${BASE}01`,
  QUADRA: `${BASE}02`,
  QUADRA_TURMAS: `${BASE}03`,
  ADMIN_USUARIO: `${BASE}10`,
  ALUNO1_USUARIO: `${BASE}11`,
  ALUNO2_USUARIO: `${BASE}12`,
  ALUNO1: `${BASE}21`,
  ALUNO2: `${BASE}22`,
  ADMIN_EMAIL: 'spec076-admin@teste.local',
  ALUNO1_EMAIL: 'spec076-aluno1@teste.local',
  ALUNO2_EMAIL: 'spec076-aluno2@teste.local',
};
const UPROF = `${BASE}31`;
const PROF = `${BASE}32`;
const PROF_EMAIL = 'spec076-prof@teste.local';
const TURMA = `${BASE}33`;
const OUTRA_TURMA = `${BASE}34`;
const AULA = `${BASE}35`;

const db = new PrismaClient();
let app: INestApplication<App>;
let professor: Sessao;
let gestor: Sessao;
let aluno: Sessao;

const ontem = (): string => {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Linhas completas da ocorrência — conteúdo, e não contagem. */
const fotografia = async () =>
  JSON.stringify(
    await db.$queryRawUnsafe(
      `SELECT (SELECT row_to_json(c) FROM chamadas c WHERE c.ocupacao_id = $1::uuid) AS cab,
              (SELECT json_agg(p ORDER BY p.aluno_id) FROM presencas p WHERE p.ocupacao_id = $1::uuid) AS linhas`,
      AULA,
    ),
  );

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  const q = (sql: string) => db.$executeRawUnsafe(sql);
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,termo_versao_aceita,updated_at) VALUES ('${UPROF}','${PROF_EMAIL}','${hash}','Prof SPEC-076','professor','${C.EMPRESA}',1,now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${PROF}','${C.EMPRESA}','Prof SPEC-076','${UPROF}',now())`,
  );
  for (const [id, nome] of [
    [TURMA, 'Turma SPEC-076'],
    [OUTRA_TURMA, 'Outra SPEC-076'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status,nivel_id) VALUES ('${id}','${C.EMPRESA}','${nome}','${C.QUADRA_TURMAS}','${PROF}',10,'ativa',${primeiroNivelSql(`'${C.EMPRESA}'`)})`,
    );
  }
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${C.ALUNO1}',now())`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${AULA}','${C.EMPRESA}','${C.QUADRA_TURMAS}','${ontem()}','08:00','09:00','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
  // Uma chamada AUTOMÁTICA com linha: é o estado que o `PUT` antigo aceitava
  // corrigir (dentro dos 7 dias do fechamento).
  await q(
    `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial,fechada_automaticamente_em)
     VALUES ('${AULA}','TURMA','${C.EMPRESA}',NULL,now(),'completa',1,'automatica','automatica',clock_timestamp())`,
  );
  await q(
    `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
     VALUES (gen_random_uuid(),'${C.EMPRESA}','${AULA}','TURMA','${C.ALUNO1}','presente',NULL,now())`,
  );

  app = await subirAppReal();
  professor = await login(app, PROF_EMAIL);
  gestor = await login(app, C.ADMIN_EMAIL);
  aluno = await login(app, C.ALUNO1_EMAIL);
});

afterAll(async () => {
  if (app) await app.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

const com = (s: Sessao) => ({ Authorization: `Bearer ${s.accessToken}` });

describe('SPEC-076 — a rota de gravar presença saiu, a de ler ficou', () => {
  it('AC-001: PUT com corpo válido, como o professor da turma → 404 do ROTEADOR, e nada muda', async () => {
    const antes = await fotografia();

    const res = await request(app.getHttpServer())
      .put(`/api/v1/me/teacher/attendance/${AULA}`)
      .set(com(professor))
      .send({
        versao: 'qualquer',
        itens: [{ alunoId: C.ALUNO1, status: 'ausente' }],
      });

    expect(res.status).toBe(404);
    // A mensagem do roteador do Nest para rota inexistente — um handler que
    // sobrasse e jogasse `NotFoundException` não diria isto.
    expect(String((res.body as { message?: string }).message)).toContain(
      `Cannot PUT /api/v1/me/teacher/attendance/${AULA}`,
    );
    expect(await fotografia()).toBe(antes);
  });

  it('AC-003: o GET responde ao professor, com status, faltaAvisada e desfazerNaoHouveAte', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/me/teacher/attendance/${AULA}`)
      .set(com(professor));

    expect(res.status).toBe(200);
    const corpo = res.body as {
      desfazerNaoHouveAte: string | null;
      alunos: { alunoId: string; status: string; faltaAvisada: boolean }[];
    };
    expect(corpo).toHaveProperty('desfazerNaoHouveAte', null);
    expect(corpo.alunos).toEqual([
      expect.objectContaining({
        alunoId: C.ALUNO1,
        status: 'presente',
        faltaAvisada: false,
      }),
    ]);
  });
});

describe('SPEC-076/D3 — as rotas do "Desfazer"', () => {
  it('professor: DELETE …/nao-houve sem nao_houve gravado → 200 com o estado atual, nada muda', async () => {
    const antes = await fotografia();
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/me/teacher/attendance/${AULA}/nao-houve`)
      .set(com(professor));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ocupacaoId: AULA, estado: 'feita' });
    expect(await fotografia()).toBe(antes);
  });

  it('professor: registrar e desfazer pela rede', async () => {
    const put = await request(app.getHttpServer())
      .put(`/api/v1/me/teacher/attendance/${AULA}/nao-houve`)
      .set(com(professor));
    expect(put.status).toBe(200);
    const lida = await request(app.getHttpServer())
      .get(`/api/v1/me/teacher/attendance/${AULA}`)
      .set(com(professor));
    expect(
      (lida.body as { desfazerNaoHouveAte: string | null }).desfazerNaoHouveAte,
    ).not.toBeNull();

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/me/teacher/attendance/${AULA}/nao-houve`)
      .set(com(professor));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ocupacaoId: AULA, estado: 'feita' });
  });

  it('aluno na rota do professor → 403', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/me/teacher/attendance/${AULA}/nao-houve`)
      .set(com(aluno));
    expect(res.status).toBe(403);
  });

  it('gestor: DELETE /classes/:turmaId/…/nao-houve com a turma certa → 200; com outra turma → 404', async () => {
    const certa = await request(app.getHttpServer())
      .delete(`/api/v1/classes/${TURMA}/presencas/${AULA}/nao-houve`)
      .set(com(gestor));
    expect(certa.status).toBe(200);

    const errada = await request(app.getHttpServer())
      .delete(`/api/v1/classes/${OUTRA_TURMA}/presencas/${AULA}/nao-houve`)
      .set(com(gestor));
    expect(errada.status).toBe(404);
  });

  it('professor na rota do gestor → 403', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/classes/${TURMA}/presencas/${AULA}/nao-houve`)
      .set(com(professor));
    expect(res.status).toBe(403);
  });
});

/**
 * SPEC-078/AC-007 e AC-016 — **as ações do aluno avisam o gestor pela ROTA
 * real**, com o app Nest inteiro: guardas, pipes, controllers e a transação de
 * verdade contra o Postgres do job.
 *
 * O gestor lê o que recebeu pela **própria caixa de avisos** (`GET
 * /me/avisos`), e não pela tabela: é onde ele vê.
 *
 * AC-016 é a fila de espera: confirmar a vez compõe `marcarNaTransacao` (fila
 * de aula) ou `entrarNaTransacao` (fila de turma), e o gestor recebe o MESMO
 * aviso da ação feita pela tela (decisão I12 do Israel).
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { diaNoFuturo } from '../banco/datas-relativas';
import { momentoDaAula } from '../../src/push/avisos-de-gesto';
import { subirAppReal } from './app-real';
import {
  login,
  montarCenario,
  type IdsDoCenario,
  type Sessao,
} from './cenario';

jest.setTimeout(180_000);
exigirBancoLocal();

const base = 'f0780003-0000-4000-8000-0000000000';
const C: IdsDoCenario = {
  EMPRESA: `${base}01`,
  QUADRA: `${base}02`,
  QUADRA_TURMAS: `${base}03`,
  ADMIN_USUARIO: `${base}10`,
  ALUNO1_USUARIO: `${base}11`,
  ALUNO2_USUARIO: `${base}12`,
  ALUNO1: `${base}21`,
  ALUNO2: `${base}22`,
  ADMIN_EMAIL: 'fit078-admin@teste.local',
  ALUNO1_EMAIL: 'fit078-aluno1@teste.local',
  ALUNO2_EMAIL: 'fit078-aluno2@teste.local',
};
const T1 = `${base}31`;
const T2 = `${base}32`;
const T3 = `${base}33`;

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
let app: INestApplication<App>;
let gestor: Sessao;
let aluno1: Sessao;
let aluno2: Sessao;
let seq = 1000;
/** Faixa própria, longe dos ids do cenário (que terminam em 01 a 33). */
const novoId = () =>
  `f0780003-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface Aula {
  id: string;
  data: Date;
  horaInicio: Date;
}

async function ocorrencia(
  turmaId: string,
  dia: string,
  hora: string,
): Promise<Aula> {
  const oc = novoId();
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
           VALUES ('${oc}','${C.EMPRESA}','${C.QUADRA_TURMAS}','${dia}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`);
  return {
    id: oc,
    data: new Date(`${dia}T00:00:00.000Z`),
    horaInicio: new Date(`1970-01-01T${hora}:00.000Z`),
  };
}

async function falta(alunoId: string, ocupacaoId: string): Promise<string> {
  const f = novoId();
  await q(`INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
           VALUES ('${f}','${C.EMPRESA}','${ocupacaoId}','${alunoId}',now())`);
  return f;
}

async function chamada(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
  prazoHoras: number;
}): Promise<string> {
  const f = novoId();
  await q(`INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
           VALUES ('${f}','${C.EMPRESA}','${opcoes.alunoId}',
                   ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
                   ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
                   ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
                   'chamado', now() - interval '1 hour', now() + interval '${opcoes.prazoHoras} hours')`);
  return f;
}

/** O que o gestor vê na caixa, mais antigo primeiro. */
async function caixaDoGestor(): Promise<{ titulo: string; corpo: string }[]> {
  const res = await request(app.getHttpServer())
    .get('/api/v1/me/avisos?pageSize=50')
    .set('Authorization', `Bearer ${gestor.accessToken}`)
    .expect(200);
  const corpo = res.body as { data: { titulo: string; corpo: string }[] };
  return corpo.data
    .map((a) => ({ titulo: a.titulo, corpo: a.corpo }))
    .reverse();
}

const comoAluno = (s: Sessao) => ({ Authorization: `Bearer ${s.accessToken}` });

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  for (const [t, nome] of [
    [T1, 'Turma 1'],
    [T2, 'Turma 2'],
    [T3, 'Turma 3'],
  ]) {
    await q(`INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status)
             VALUES ('${t}','${C.EMPRESA}','${nome}','${C.QUADRA_TURMAS}',10,'ativa')`);
  }
  for (const a of [C.ALUNO1, C.ALUNO2]) {
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${T1}','${a}',now())`,
    );
  }
  app = await subirAppReal();
  gestor = await login(app, C.ADMIN_EMAIL);
  aluno1 = await login(app, C.ALUNO1_EMAIL);
  aluno2 = await login(app, C.ALUNO2_EMAIL);
});

afterAll(async () => {
  await app?.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

describe('SPEC-078/AC-007 — as seis ações pela rota, e o gestor lê na caixa', () => {
  it('falta, reposição e turma: seis gestos, seis avisos, na ordem', async () => {
    const aulaFutura = await ocorrencia(T1, diaNoFuturo(9), '19:00');
    const perdida = await ocorrencia(T1, diaNoFuturo(-3), '19:00');
    const credito = await falta(C.ALUNO1, perdida.id);
    const destino = await ocorrencia(T2, diaNoFuturo(6), '20:00');
    const rota = `/api/v1/me/classes/${T1}/aulas/${aulaFutura.id}/falta`;
    const server = app.getHttpServer();

    await request(server).post(rota).set(comoAluno(aluno1)).expect(204);
    await request(server).delete(rota).set(comoAluno(aluno1)).expect(204);
    const marcada = await request(server)
      .post('/api/v1/me/reposicoes')
      .set(comoAluno(aluno1))
      .send({ faltaId: credito, ocupacaoId: destino.id });
    expect(marcada.status).toBeLessThan(300);
    const reposicaoId = (marcada.body as { id: string }).id;
    await request(server)
      .delete(`/api/v1/me/reposicoes/${reposicaoId}`)
      .set(comoAluno(aluno1))
      .expect(204);
    const entrou = await request(server)
      .post(`/api/v1/me/classes/${T2}`)
      .set(comoAluno(aluno1));
    expect(entrou.status).toBeLessThan(300);
    const saiu = await request(server)
      .delete(`/api/v1/me/classes/${T2}`)
      .set(comoAluno(aluno1));
    expect(saiu.status).toBeLessThan(300);

    const mf = momentoDaAula(aulaFutura.data, aulaFutura.horaInicio);
    const md = momentoDaAula(destino.data, destino.horaInicio);
    expect(await caixaDoGestor()).toEqual([
      {
        titulo: 'Faltas',
        corpo: `Um aluno avisou que vai faltar na aula de ${mf}`,
      },
      {
        titulo: 'Faltas',
        corpo: `Um aluno retirou o aviso de falta da aula de ${mf}`,
      },
      { titulo: 'Reposições', corpo: `Uma reposição foi marcada para ${md}` },
      { titulo: 'Reposições', corpo: `Uma reposição de ${md} foi desmarcada` },
      { titulo: 'Turmas', corpo: 'Um aluno entrou em uma das turmas' },
      { titulo: 'Turmas', corpo: 'Um aluno saiu de uma das turmas' },
    ]);
  });
});

describe('SPEC-078/AC-016 — a confirmação da fila avisa igual', () => {
  it('fila de AULA: "Uma reposição foi marcada…"; fila de TURMA: "Um aluno entrou…"; vez vencida: nada', async () => {
    const antes = (await caixaDoGestor()).length;
    const perdida = await ocorrencia(T1, diaNoFuturo(-4), '07:00');
    const credito = await falta(C.ALUNO2, perdida.id);
    const alvo = await ocorrencia(T2, diaNoFuturo(8), '09:00');
    const server = app.getHttpServer();

    const daAula = await chamada({
      alunoId: C.ALUNO2,
      ocupacaoId: alvo.id,
      faltaId: credito,
      prazoHoras: 6,
    });
    await request(server)
      .post(`/api/v1/me/fila-de-espera/${daAula}/confirmar`)
      .set(comoAluno(aluno2))
      .expect(200);

    const daTurma = await chamada({
      alunoId: C.ALUNO2,
      turmaId: T3,
      prazoHoras: 6,
    });
    await request(server)
      .post(`/api/v1/me/fila-de-espera/${daTurma}/confirmar`)
      .set(comoAluno(aluno2))
      .expect(200);

    const vencida = await chamada({
      alunoId: C.ALUNO1,
      turmaId: T3,
      prazoHoras: -1,
    });
    await request(server)
      .post(`/api/v1/me/fila-de-espera/${vencida}/confirmar`)
      .set(comoAluno(aluno1))
      .expect(409);

    const novos = (await caixaDoGestor()).slice(antes);
    expect(novos).toEqual([
      {
        titulo: 'Reposições',
        corpo: `Uma reposição foi marcada para ${momentoDaAula(alvo.data, alvo.horaInicio)}`,
      },
      { titulo: 'Turmas', corpo: 'Um aluno entrou em uma das turmas' },
    ]);
  });
});

/**
 * SPEC-043 — fixture e leituras de banco compartilhadas pelos FITs de PR.
 *
 * Fixture em SQL cru, como os `db-spec` (FIT-010 explica: `quadras` tem FK
 * composta para `esportes_de_quadra`, e a forma de entrada do Prisma para
 * isso é mais ruído que o INSERT). Tudo sob UMA empresa, para que
 * `limparEmpresa` apague tudo no fim — inclusive as tabelas append-only,
 * pela válvula de limpeza (SPEC-032/TASK-005).
 *
 * **Duas quadras, de propósito.** As turmas do cenário (c) geram ocorrências
 * semanais em datas que os cenários (a), (b) e (d) também usam; numa quadra
 * só, uma reserva avulsa do (a) poderia derrubar as DUAS turmas por conflito
 * e o (c) passaria dizendo nada.
 *
 * **Alunos com `vinculo='aprovado'` e termo aceito.** O que está em
 * julgamento é a concorrência; com `pendente` ou sem aceite, o cancelamento
 * do aluno no (d) falharia por 403 e o teste passaria pelo motivo errado
 * (a mesma armadilha que o FIT-010 documenta).
 */
import type { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';

export interface ClienteDeFit {
  $executeRawUnsafe(sql: string, ...valores: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...valores: unknown[]): Promise<T>;
}

export const EMPRESA = 'f0430000-0000-4000-8000-000000000001';
export const QUADRA = 'f0430000-0000-4000-8000-000000000002';
export const QUADRA_TURMAS = 'f0430000-0000-4000-8000-000000000003';
export const ADMIN_USUARIO = 'f0430000-0000-4000-8000-000000000010';
export const ALUNO1_USUARIO = 'f0430000-0000-4000-8000-000000000011';
export const ALUNO2_USUARIO = 'f0430000-0000-4000-8000-000000000012';
export const ALUNO1 = 'f0430000-0000-4000-8000-000000000021';
export const ALUNO2 = 'f0430000-0000-4000-8000-000000000022';

export const ADMIN_EMAIL = 'fit043-admin@teste.local';
export const ALUNO1_EMAIL = 'fit043-aluno1@teste.local';
export const ALUNO2_EMAIL = 'fit043-aluno2@teste.local';
export const SENHA = 'fit-043-senha-forte';

export async function montarCenario(db: ClienteDeFit): Promise<void> {
  // Custo baixo de propósito: é fixture, não produção.
  const senhaHash = await bcrypt.hash(SENHA, 4);
  const q = (sql: string) => db.$executeRawUnsafe(sql);

  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-043','fit-043',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  for (const [id, nome] of [
    [QUADRA, 'Q FIT-043 reservas'],
    [QUADRA_TURMAS, 'Q FIT-043 turmas'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${id}','${EMPRESA}','${nome}',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN_USUARIO}','${ADMIN_EMAIL}','${senhaHash}','Admin FIT-043','company_admin','${EMPRESA}',now())`,
  );
  for (const [usuarioId, alunoId, email, n] of [
    [ALUNO1_USUARIO, ALUNO1, ALUNO1_EMAIL, 1],
    [ALUNO2_USUARIO, ALUNO2, ALUNO2_EMAIL, 2],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,termo_versao_aceita,updated_at) VALUES ('${usuarioId}','${email}','${senhaHash}','Aluno FIT-043 ${n}','aluno','${EMPRESA}',1,now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado')`,
    );
  }
}

export interface Sessao {
  accessToken: string;
  refreshToken: string;
  cookieRefresh: string;
}

export async function login(
  app: INestApplication<App>,
  email: string,
  senha = SENHA,
): Promise<Sessao> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, senha });
  if (res.status !== 200) {
    throw new Error(`login de ${email} devolveu ${res.status}: ${res.text}`);
  }
  const setCookie = String(res.headers['set-cookie'] ?? '');
  const cookie = /refresh_token=([^;]+)/.exec(setCookie)?.[1] ?? '';
  const corpo = res.body as { accessToken: string; refreshToken: string };
  return {
    accessToken: corpo.accessToken,
    refreshToken: corpo.refreshToken,
    cookieRefresh: cookie,
  };
}

/** `AAAA-MM-DD` em UTC, `dias` à frente. Só datas futuras: a SPEC-042
 *  recusa aluno operando no passado, e isso não é o que está em teste. */
export function dataFutura(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function um<T>(db: ClienteDeFit, sql: string): Promise<T> {
  const linhas = await db.$queryRawUnsafe<T[]>(sql);
  return linhas[0];
}

/** Ocupações NÃO canceladas de uma quadra num dia/hora — o que a INV-001
 *  diz que nunca pode passar de 1. */
export async function ativasNoSlot(
  db: ClienteDeFit,
  quadraId: string,
  data: string,
  horaInicio: string,
): Promise<number> {
  const r = await um<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM ocupacoes_quadra WHERE quadra_id='${quadraId}' AND data='${data}'::date AND hora_inicio='${horaInicio}'::time AND status_pagamento <> 'cancelado'`,
  );
  return Number(r.n);
}

export async function ocupacao(
  db: ClienteDeFit,
  id: string,
): Promise<{ status_pagamento: string; transicao_id: string | null }> {
  return um(
    db,
    `SELECT status_pagamento, transicao_id FROM ocupacoes_quadra WHERE id='${id}'`,
  );
}

/** INV-064: cancelou, tem evento `cancelada` DESTA transição. */
export async function eventoDeCancelamento(
  db: ClienteDeFit,
  ocupacaoId: string,
  transicaoId: string,
): Promise<number> {
  const r = await um<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM eventos_de_ocupacao WHERE ocupacao_id='${ocupacaoId}' AND tipo='cancelada' AND transicao_id='${transicaoId}'`,
  );
  return Number(r.n);
}

export async function turmasComNome(
  db: ClienteDeFit,
  nome: string,
): Promise<number> {
  const r = await um<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM turmas WHERE company_id='${EMPRESA}' AND nome='${nome}'`,
  );
  return Number(r.n);
}

export async function ocorrenciasDaTurma(
  db: ClienteDeFit,
  turmaNome: string,
): Promise<number> {
  const r = await um<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM ocupacoes_quadra WHERE origem_turma_id IN (SELECT id FROM turmas WHERE company_id='${EMPRESA}' AND nome='${turmaNome}')`,
  );
  return Number(r.n);
}

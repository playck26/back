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

/**
 * **Uma fixture por suíte, e é por isso que os ids levam o número da suíte.**
 * No `db-migrate.yml` os canários `FIT-001 Neon` e `FIT-002 Neon` são jobs
 * PARALELOS contra o mesmo DEV (run 33793671991): com a mesma empresa nas
 * duas, o `afterAll` do FIT-002 — mais curto — apagou a fixture no meio do
 * FIT-001 (iteração 1 `500/500`, depois `404/404`, quadra inexistente). No
 * CI não aparece: o `fit-critical` roda os dois arquivos em série. Isolar
 * por id fecha o problema onde ele nasce, sem depender da ordem dos jobs.
 */
export interface IdsDoCenario {
  EMPRESA: string;
  QUADRA: string;
  QUADRA_TURMAS: string;
  ADMIN_USUARIO: string;
  ALUNO1_USUARIO: string;
  ALUNO2_USUARIO: string;
  ALUNO1: string;
  ALUNO2: string;
  ADMIN_EMAIL: string;
  ALUNO1_EMAIL: string;
  ALUNO2_EMAIL: string;
}

export function idsDoCenario(suite: number): IdsDoCenario {
  const base = `f043000${suite}-0000-4000-8000-0000000000`;
  return {
    EMPRESA: `${base}01`,
    QUADRA: `${base}02`,
    QUADRA_TURMAS: `${base}03`,
    ADMIN_USUARIO: `${base}10`,
    ALUNO1_USUARIO: `${base}11`,
    ALUNO2_USUARIO: `${base}12`,
    ALUNO1: `${base}21`,
    ALUNO2: `${base}22`,
    ADMIN_EMAIL: `fit043-${suite}-admin@teste.local`,
    ALUNO1_EMAIL: `fit043-${suite}-aluno1@teste.local`,
    ALUNO2_EMAIL: `fit043-${suite}-aluno2@teste.local`,
  };
}

// Suíte 1 (FIT-001) por nome, para os helpers e o arquivo já escrito.
const C1 = idsDoCenario(1);
export const EMPRESA = C1.EMPRESA;
export const QUADRA = C1.QUADRA;
export const QUADRA_TURMAS = C1.QUADRA_TURMAS;
export const ADMIN_USUARIO = C1.ADMIN_USUARIO;
export const ALUNO1_USUARIO = C1.ALUNO1_USUARIO;
export const ALUNO2_USUARIO = C1.ALUNO2_USUARIO;
export const ALUNO1 = C1.ALUNO1;
export const ALUNO2 = C1.ALUNO2;
export const ADMIN_EMAIL = C1.ADMIN_EMAIL;
export const ALUNO1_EMAIL = C1.ALUNO1_EMAIL;
export const ALUNO2_EMAIL = C1.ALUNO2_EMAIL;
export const SENHA = 'fit-043-senha-forte';

export async function montarCenario(
  db: ClienteDeFit,
  ids: IdsDoCenario = C1,
): Promise<void> {
  const {
    EMPRESA,
    QUADRA,
    QUADRA_TURMAS,
    ADMIN_USUARIO,
    ALUNO1_USUARIO,
    ALUNO2_USUARIO,
    ALUNO1,
    ALUNO2,
    ADMIN_EMAIL,
    ALUNO1_EMAIL,
    ALUNO2_EMAIL,
  } = ids;
  // Custo baixo de propósito: é fixture, não produção.
  const senhaHash = await bcrypt.hash(SENHA, 4);
  const q = (sql: string) => db.$executeRawUnsafe(sql);

  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-043 ${EMPRESA}','fit-043-${EMPRESA}',now())`,
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

/** A ocorrência de índice `indice` de uma turma, em ordem de data. `1` é
 *  a segunda semana — nunca "hoje", que a SPEC-042/DEF-020 tratam à parte. */
export async function ocorrenciaDaTurma(
  db: ClienteDeFit,
  turmaId: string,
  indice: number,
): Promise<{ id: string; data: string }> {
  return um(
    db,
    `SELECT id, to_char(data, 'YYYY-MM-DD') AS data FROM ocupacoes_quadra WHERE origem_turma_id='${turmaId}' ORDER BY data OFFSET ${indice} LIMIT 1`,
  );
}

/** INV-064 por linha: ocorrências canceladas de uma turma SEM evento
 *  `cancelada` da própria transição. Com `updateMany` no lugar de
 *  `updateManyAndReturn` (a sabotagem 3 da SPEC-043) não há ids para
 *  registrar — e a trigger DEFERRED derruba a transação no COMMIT. */
export async function canceladasSemEvento(
  db: ClienteDeFit,
  turmaId: string,
): Promise<number> {
  const r = await um<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM ocupacoes_quadra o WHERE o.origem_turma_id='${turmaId}' AND o.status_pagamento='cancelado' AND NOT EXISTS (SELECT 1 FROM eventos_de_ocupacao e WHERE e.ocupacao_id=o.id AND e.tipo='cancelada' AND e.transicao_id=o.transicao_id)`,
  );
  return Number(r.n);
}

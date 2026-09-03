/**
 * SPEC-043 — **FIT-002 como check de PR: rotação atômica do refresh token.**
 *
 * O original (bash + curl no `db-migrate.yml`) disparava dois
 * `POST /auth/refresh` com o mesmo cookie e conferia só os códigos
 * (`200/401`). Aqui, além dos códigos, o BANCO: depois do par, o usuário
 * tem exatamente UM token vivo a mais do que tinha e o antigo está revogado
 * — dois pares emitidos seriam `200/200` no HTTP, mas também seriam DUAS
 * linhas novas, e é a segunda leitura que pega o defeito se a primeira
 * escapar.
 *
 * Mesmas duas pools do FIT-001 (dois apps), pelo mesmo motivo. Cada
 * iteração faz login próprio: o token em disputa nasce fresco.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  idsDoCenario,
  login,
  montarCenario,
  type ClienteDeFit,
} from './cenario';

// Suíte 2: fixture própria, porque no canário Neon este arquivo roda em
// PARALELO com o FIT-001 contra o mesmo banco (ver `cenario.ts`).
const C = idsDoCenario(2);

jest.setTimeout(300_000);
exigirBancoLocal();

const db = new PrismaClient();
let appA: INestApplication<App>;
let appB: INestApplication<App>;

const ITERACOES = 5;

async function tokensDoUsuario(
  cliente: ClienteDeFit,
): Promise<{ total: number; vivos: number }> {
  const [linha] = await cliente.$queryRawUnsafe<
    { total: number; vivos: number }[]
  >(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE revoked_at IS NULL)::int AS vivos FROM refresh_tokens WHERE usuario_id='${C.ADMIN_USUARIO}'`,
  );
  return { total: Number(linha.total), vivos: Number(linha.vivos) };
}

function refresh(app: INestApplication<App>, cookieRefresh: string) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/refresh')
    .set('Cookie', [`refresh_token=${cookieRefresh}`]);
}

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

describe('FIT-002 — duas rotações simultâneas do mesmo refresh token', () => {
  it(`${ITERACOES} pares: 200/401, exatamente um token novo, o antigo revogado`, async () => {
    const falhas: string[] = [];
    for (let i = 0; i < ITERACOES; i++) {
      const sessao = await login(appA, C.ADMIN_EMAIL);
      const antes = await tokensDoUsuario(db);

      const [r1, r2] = await Promise.all([
        refresh(appA, sessao.cookieRefresh),
        refresh(appB, sessao.cookieRefresh),
      ]);
      const par = [r1.status, r2.status].sort((x, y) => x - y);

      const depois = await tokensDoUsuario(db);
      const problemas: string[] = [];
      if (par[0] !== 200 || par[1] !== 401) {
        problemas.push(`códigos ${r1.status}/${r2.status}`);
      }
      // Um par emitido = uma linha a mais; dois pares = duas.
      if (depois.total !== antes.total + 1) {
        problemas.push(
          `linhas: ${antes.total} → ${depois.total} (esperado +1)`,
        );
      }
      // No máximo UM token vivo. Não "exatamente um": a perdedora da corrida
      // é tratada como reuso (REQ-003, sinal de comprometimento) e revoga a
      // sessão inteira — se ela rodar DEPOIS de a vencedora emitir o par
      // novo, revoga esse também, e sobram zero vivos. Zero ou um são a
      // regra funcionando; dois é o defeito (dois pares emitidos).
      if (depois.vivos > 1) {
        problemas.push(`tokens vivos=${depois.vivos} (esperado 0 ou 1)`);
      }
      if (problemas.length) {
        falhas.push(`iteração ${i + 1}: ${problemas.join(', ')}`);
      }
    }
    expect(falhas).toEqual([]);
  });
});

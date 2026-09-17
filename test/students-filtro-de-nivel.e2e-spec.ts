import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-057/TASK-004 (card 5350) — **`?nivelId=` pela camada HTTP.**
 *
 * Este arquivo existe por causa de uma forma de falha específica:
 * `alunos.nivel_id` é `uuid` no banco, e string livre num `where` de UUID
 * **não** dá `400` — dá erro do Prisma, que vira `500`. A validação mora no
 * DTO, e é aqui que se prova que ela roda.
 *
 * É também a lição do DEF-034 aplicada de véspera: parâmetro de query que
 * ninguém exercitou por HTTP é parâmetro cujo contrato ninguém mediu.
 */
const ROTA = '/api/v1/students';

describe('Alunos por nível (e2e) — SPEC-057/TASK-004', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoGestor() {
    const gestor = await buildUsuarioAtivo({
      id: 'u-gestor',
      email: 'gestor@empresa.demo',
      role: 'company_admin',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, gestor);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.aluno.findMany.mockResolvedValue([]);
    prisma.aluno.count.mockResolvedValue(0);
    return accessToken;
  }

  const whereDaChamada = () =>
    (
      prisma.aluno.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;

  it('um UUID é aceito e chega ao filtro', async () => {
    const accessToken = await comoGestor();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ nivelId: '11111111-1111-4111-8111-111111111111' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    expect(whereDaChamada().nivelId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('`semNivel=true` é aceito, e vira `null` no filtro', async () => {
    const accessToken = await comoGestor();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ semNivel: 'true' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    expect(whereDaChamada().nivelId).toBeNull();
  });

  /**
   * **O caso que justifica o arquivo.** Sem a validação no DTO, isto chegaria
   * ao Prisma e sairia como `500`.
   */
  it.each([['abc'], ['1; DROP TABLE alunos'], ['SEM_NIVEL']])(
    'valor inválido (%s) é recusado com 400, e não chega ao banco',
    async (valor) => {
      const accessToken = await comoGestor();

      const resposta = await request(app.getHttpServer())
        .get(ROTA)
        .query({ nivelId: valor })
        .set('Authorization', `Bearer ${accessToken}`);

      expect(resposta.status).toBe(400);
      expect(prisma.aluno.findMany).not.toHaveBeenCalled();
    },
  );

  it('sem o parâmetro, o filtro não existe — ausência é ausência', async () => {
    const accessToken = await comoGestor();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    expect(whereDaChamada()).not.toHaveProperty('nivelId');
  });

  /**
   * **AC-027 — o catálogo de níveis continua fechado para o aluno.** O filtro
   * do app monta as opções com o que já vem no payload das turmas; abrir
   * `GET /levels` seria superfície nova sem necessidade.
   */
  it('AC-027: o aluno não lê o catálogo de níveis', async () => {
    const aluno = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'aluno@empresa.demo',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    const resposta = await request(app.getHttpServer())
      .get('/api/v1/levels')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(403);
  });
});

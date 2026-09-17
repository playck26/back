import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-057/TASK-002/D11 (card 5352) — **a janela por data, pela camada HTTP.**
 *
 * O card pede que o aluno navegue para semanas anteriores e veja o que
 * passou. Hoje `GET /me/classes` devolve só o futuro, e a semana anterior vem
 * com sete travessões **por definição do contrato**.
 *
 * Este arquivo prova o contrato **observável**, que é o que a v1 da spec não
 * definia e o veredito independente cobrou: tamanho, fronteiras, data
 * inválida, inversão e ausência.
 *
 * **E prova os dois lados do rollout:** sem os parâmetros, a resposta é a de
 * antes — é isso que mantém o Cliente atual funcionando enquanto o novo não
 * sobe.
 */
const ROTA = '/api/v1/me/classes';

describe('A janela das aulas do aluno (e2e) — SPEC-057/TASK-002', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoAluno() {
    const aluno = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'aluno@empresa.demo',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.aluno.findFirst.mockResolvedValue({ id: 'aluno-1' });
    prisma.turmaAluno.findMany.mockResolvedValue([{ turmaId: 't-1' }]);
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    return accessToken;
  }

  const filtroDeData = () =>
    (
      prisma.ocupacaoQuadra.findMany.mock.calls[0] as [
        { where: { data: Record<string, Date> } },
      ]
    )[0].where.data;

  it('sem parâmetros, a resposta é a de hoje em diante — o contrato de antes', async () => {
    const accessToken = await comoAluno();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    const data = filtroDeData();
    expect(data.gte).toBeInstanceOf(Date);
    expect(data.lte).toBeUndefined();
  });

  it('com `de` e `ate`, a janela é inclusiva nos dois extremos', async () => {
    const accessToken = await comoAluno();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de: '2026-09-01', ate: '2026-09-07' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    const data = filtroDeData();
    expect(data.gte.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(data.lte.toISOString().slice(0, 10)).toBe('2026-09-07');
  });

  it('a janela alcança o PASSADO — que é o ponto do card', async () => {
    const accessToken = await comoAluno();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de: '2020-01-01', ate: '2020-01-07' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    expect(filtroDeData().gte.toISOString().slice(0, 10)).toBe('2020-01-01');
  });

  it('um só dos dois é 400 — meia janela seria adivinhação', async () => {
    const accessToken = await comoAluno();

    for (const query of [{ de: '2026-09-01' }, { ate: '2026-09-07' }]) {
      const resposta = await request(app.getHttpServer())
        .get(ROTA)
        .query(query)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(resposta.status).toBe(400);
    }
  });

  it('invertida é 400', async () => {
    const accessToken = await comoAluno();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de: '2026-09-07', ate: '2026-09-01' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(400);
  });

  it('acima de 90 dias é 400 — e 90 exatos passam', async () => {
    const accessToken = await comoAluno();

    const longa = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de: '2026-01-01', ate: '2026-12-31' })
      .set('Authorization', `Bearer ${accessToken}`);
    expect(longa.status).toBe(400);

    const noLimite = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de: '2026-01-01', ate: '2026-03-31' }) // 90 dias
      .set('Authorization', `Bearer ${accessToken}`);
    expect(noLimite.status).toBe(200);
  });

  /**
   * **DEF-020 outra vez.** `@IsDateString()` aceitaria `2026-02-30` e o
   * `parseDateOnly` normalizaria em silêncio: a rota responderia `200` com
   * uma janela que ninguém pediu.
   */
  it.each([
    ['2026-02-30'],
    ['2026-13-01'],
    ['ontem'],
    ['2026-09-10T12:00:00Z'],
  ])('dia que não existe no calendário (%s) é 400', async (de) => {
    const accessToken = await comoAluno();

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ de, ate: '2026-09-30' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(400);
  });
});

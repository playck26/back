import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * DEF-034 — **a rota das aulas do professor recusava a query do próprio app.**
 *
 * ## Como apareceu
 *
 * No teste em aparelho da SPEC-056 (2026-09-16) a ficha da turma abriu sem aula
 * nenhuma. Os dados existiam — o painel do gestor lista "AULAS CANCELADAS" com
 * as sextas, e a reprodução em banco local devolveu 8 itens em 30 e em 90 dias.
 * O que faltava medir era a única camada sem teste: **a rota**.
 *
 * ## A causa
 *
 * `GET /me/teacher/classes/:id/ocorrencias` declarava `dias` por
 * `@Query('dias', …)` **e** o resto da query por `@Query() PaginationQueryDto`.
 * Com a validação global em `forbidNonWhitelisted: true`, o objeto da query
 * inteiro é conferido contra o DTO de paginação — e `dias` não é propriedade
 * dele. Medido aqui antes da correção:
 *
 * | Query | Resposta |
 * |---|---|
 * | `?dias=30&page=1&pageSize=20` (a que o app manda) | **400** `property dias should not exist` |
 * | `?dias=90&…` (turma inativa, SPEC-056/D3) | **400** |
 * | `?page=1&pageSize=20`, sem `dias` | 200 |
 *
 * Ou seja, **a lista de aulas do professor nunca funcionou em produção** desde
 * que o app passou a mandar `dias` — e ninguém viu, porque a tela engolia a
 * falha em silêncio (DEF-033, cliente#24).
 *
 * ## Por que este arquivo existe
 *
 * O db-spec da SPEC-027 exercita o **serviço**; os unitários montam o
 * controller **sem pipe**. Os dois passavam. **Rota sem teste de HTTP é rota
 * cujo contrato ninguém mediu** — e a query que o app manda era exatamente a
 * que faltava. É a única rota do projeto que misturava `@Query('nome')` com
 * `@Query()` de objeto (varredura em todos os controllers de `src`).
 */
const rota = (id: string) => `/api/v1/me/teacher/classes/${id}/ocorrencias`;
const TURMA = '5f899c7b-9503-46b1-a402-f9578c737876';

describe('Aulas da turma do professor (e2e) — DEF-034', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoProfessor() {
    const professor = await buildUsuarioAtivo({
      id: 'u-prof',
      email: 'prof@empresa.demo',
      role: 'professor',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, professor);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.professor.findFirst.mockResolvedValue({ id: 'prof-1' });
    prisma.turma.findFirst.mockResolvedValue({
      id: TURMA,
      nome: 'TURMA TESTE 16/09',
      _count: { alunos: 0 },
    });
    prisma.ocupacaoQuadra.count.mockResolvedValue(1);
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([
      {
        id: 'ocup-1',
        data: new Date('2026-09-18T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T11:00:00.000Z'),
        horaFim: new Date('1970-01-01T12:00:00.000Z'),
        statusPagamento: 'cancelado',
        _count: { presencas: 0 },
        chamadas: [],
      },
    ]);
    return accessToken;
  }

  /**
   * **A query do app, letra por letra.** `src/lib/api-client.ts` monta
   * `?dias=${dias}&page=${page}&pageSize=${pageSize}` — os três, sempre.
   */
  it('a query que o app do professor manda (dias=30) é aceita', async () => {
    const accessToken = await comoProfessor();

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .query({ dias: 30, page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${accessToken}`);

    // A mensagem do defeito, para quem reencontrar isto: o 400 dizia
    // `property dias should not exist`.
    expect(resposta.status).toBe(200);
    const corpo = bodyOf<{ total: number; data: { data: string }[] }>(resposta);
    expect(corpo.total).toBe(1);
    expect(corpo.data[0].data).toBe('2026-09-18');
  });

  /** SPEC-056/D3 — a turma inativa pede 90. */
  it('a query da turma inativa (dias=90) é aceita', async () => {
    const accessToken = await comoProfessor();

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .query({ dias: 90, page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
  });

  it('sem `dias`, o padrão de 30 vale e a rota responde', async () => {
    const accessToken = await comoProfessor();

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
  });

  /**
   * O teto de 90 continua sendo CORTE, não recusa — era assim antes, e mexer
   * nisso seria trocar um comportamento de carona na correção do defeito.
   *
   * **Comparar com a chamada de 90 em vez de calcular a data** deixa o teste
   * livre da definição de "hoje" (fuso do clube, início do dia): o que se
   * afirma é que 5000 e 90 pedem a MESMA janela, e é exatamente isso que o
   * corte significa.
   */
  it('`dias` acima do teto é cortado em 90 — mesma janela que dias=90', async () => {
    const accessToken = await comoProfessor();
    const janela = async (dias: number) => {
      prisma.ocupacaoQuadra.count.mockClear();
      const resposta = await request(app.getHttpServer())
        .get(rota(TURMA))
        .query({ dias, page: 1, pageSize: 20 })
        .set('Authorization', `Bearer ${accessToken}`);
      expect(resposta.status).toBe(200);
      const [args] = prisma.ocupacaoQuadra.count.mock.calls[0] as [
        { where: { data: { gte: Date } } },
      ];
      return args.where.data.gte.getTime();
    };

    expect(await janela(5000)).toBe(await janela(90));
    expect(await janela(30)).toBeGreaterThan(await janela(90));
  });

  it('`dias` que não é número é recusado', async () => {
    const accessToken = await comoProfessor();

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .query({ dias: 'muitos', page: 1 })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(400);
  });

  it('parâmetro de verdade desconhecido continua sendo recusado', async () => {
    const accessToken = await comoProfessor();

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .query({ dias: 30, page: 1, inventado: 'x' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(400);
  });
});

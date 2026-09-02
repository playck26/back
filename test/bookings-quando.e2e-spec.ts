import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-041/TASK-A6 — **as duas provas que a rota não tinha, e o rollout
 * depende das duas.**
 *
 * 1. **`excluirCanceladas` continua aceito e filtrando.** O parâmetro existe
 *    desde a SPEC-027 e **nunca teve prova nenhuma** — nem unitária, nem e2e.
 *    Manter comportamento sem rede é o que faz uma remoção "inofensiva"
 *    derrubar a tela do aluno na janela entre os dois deploys.
 *
 * 2. **Query param desconhecido devolve 400.** Isto só estava provado para o
 *    **corpo** (`auth.e2e-spec.ts:154`). A diferença deixou de ser acadêmica
 *    quando `quando` entrou: um Cliente que suba antes do Back manda um
 *    parâmetro que o DTO antigo não conhece, e `forbidNonWhitelisted` responde
 *    400 — derrubando, pelo `Promise.all` da tela, também a lista de quadras,
 *    que teria respondido 200.
 *
 * O que se prova aqui é o **mecanismo**, não a ordem de deploy: nenhum teste
 * pode provar que o DigitalOcean subiu antes da Netlify. O que ele garante é
 * que a consequência de errar a ordem é a que a spec descreve, e não uma
 * degradação silenciosa que ninguém notaria.
 */
describe('GET /bookings — o recorte temporal (SPEC-041)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    prisma.ocupacaoQuadra.count.mockResolvedValue(0);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoGestor() {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return { usuario, accessToken };
  }

  function whereEnviado() {
    const [args] = prisma.ocupacaoQuadra.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    return args.where;
  }

  it('AC-001: aceita `quando=futuras` e responde 200', async () => {
    const { accessToken } = await comoGestor();

    const res = await request(app.getHttpServer())
      .get('/api/v1/bookings?quando=futuras')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(bodyOf<{ total: number }>(res).total).toBe(0);
    expect(whereEnviado().AND).toHaveLength(1);
  });

  it('AC-001: sem `quando`, o where não ganha corte nenhum', async () => {
    const { usuario, accessToken } = await comoGestor();

    await request(app.getHttpServer())
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(whereEnviado()).toEqual({ companyId: usuario.companyId });
  });

  it('recusa um valor que não existe, em vez de cair no padrão', async () => {
    const { accessToken } = await comoGestor();

    // `?quando=ontem` é erro de quem chama, não URL velha de usuário — o
    // molde de "cai no padrão em silêncio" é da barra de abas, na tela.
    await request(app.getHttpServer())
      .get('/api/v1/bookings?quando=ontem')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  /**
   * **A prova que decide a ordem de deploy.**
   *
   * Se ela ficar vermelha um dia, é porque alguém desligou
   * `forbidNonWhitelisted` — e nesse dia o `quando` deixaria de dar 400 contra
   * um Back antigo, mas também deixaria de dar 400 para qualquer parâmetro
   * inventado. A rede que protege é a mesma.
   */
  it('query param desconhecido devolve 400 (forbidNonWhitelisted)', async () => {
    const { accessToken } = await comoGestor();

    const res = await request(app.getHttpServer())
      .get('/api/v1/bookings?parametroQueNaoExiste=1')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);

    expect(JSON.stringify(bodyOf(res))).toContain('parametroQueNaoExiste');
  });

  /**
   * **`excluirCanceladas` é o consumidor antigo, e ele tem de continuar de pé
   * durante a janela de skew.** Esta é a primeira prova que ele já teve.
   */
  it('D5: `excluirCanceladas=true` continua aceito e continua filtrando', async () => {
    const { accessToken } = await comoGestor();

    await request(app.getHttpServer())
      .get('/api/v1/bookings?page=1&pageSize=20&excluirCanceladas=true')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(whereEnviado().AND).toEqual([
      { statusPagamento: { not: 'cancelado' } },
    ]);
  });

  it('D8: o corte e o filtro antigo convivem, sem um apagar o outro', async () => {
    const { accessToken } = await comoGestor();

    // Esta é a combinação que o Cliente **antigo** produziria se o app novo
    // subisse pela metade. Nenhuma das duas condições pode sumir.
    await request(app.getHttpServer())
      .get(
        '/api/v1/bookings?quando=anteriores&status=pago&excluirCanceladas=true',
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const condicoes = whereEnviado().AND as Record<string, unknown>[];
    expect(condicoes).toHaveLength(3);
    expect(condicoes[0]).toHaveProperty('OR');
    expect(condicoes[1]).toEqual({ statusPagamento: 'pago' });
    expect(condicoes[2]).toEqual({ statusPagamento: { not: 'cancelado' } });
  });

  it('AC-004: findMany e count recebem o mesmo where, com o mesmo instante', async () => {
    const { accessToken } = await comoGestor();

    await request(app.getHttpServer())
      .get('/api/v1/bookings?quando=futuras')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [doCount] = prisma.ocupacaoQuadra.count.mock.calls[0] as [
      { where: unknown },
    ];
    expect(whereEnviado()).toBe(doCount.where);
  });
});

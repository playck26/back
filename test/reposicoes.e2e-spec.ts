import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-046 — reposição na camada HTTP.
 *
 * **O que este arquivo prova, e o que NÃO prova.** Aqui vivem as decisões que
 * só existem no HTTP: o papel que alcança cada rota (D3/LIM-046e) e a validação
 * do corpo. Que o crédito seja derivado, que a vaga saia da falta e que a
 * capacidade resista à corrida está em `spec-046-reposicao.db-spec.ts` e no
 * `fit-035` — são regras sobre dados reais, e um mock que devolve a lista que
 * eu escrevi provaria só que eu sei escrever listas.
 */
const ROTA = '/api/v1/me/reposicoes';
const ALUNO_ID = '77777777-7777-4777-8777-777777777777';

describe('Reposição (e2e) — SPEC-046', () => {
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
    const usuario = await buildUsuarioAtivo({ role: 'aluno' });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.aluno.findFirst.mockResolvedValue({ id: ALUNO_ID });
    prisma.configOperacaoEmpresa.findUnique.mockResolvedValue(null);
    prisma.faltaAvisada.findMany.mockResolvedValue([]);
    prisma.turmaAluno.findMany.mockResolvedValue([]);
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([{ n: BigInt(0) }]);
    return accessToken;
  }

  it('AC-001: o aluno vê o crédito, e ele vem com o teto do clube junto', async () => {
    const token = await comoAluno();

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Sem o teto e o "usadas", *"você tem 1 crédito"* produziria uma recusa
    // que o aluno não entende quando o mês já acabou.
    expect(res.body).toMatchObject({
      creditos: 0,
      porMes: 2,
      validadeDias: 30,
      usadasNoMes: 0,
    });
  });

  it('sem configuração do clube, valem os PADRÕES — não zero', async () => {
    const token = await comoAluno();
    prisma.configOperacaoEmpresa.findUnique.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // `?? 0` compila neste projeto e produziria "nenhuma reposição permitida"
    // — o oposto de "o clube não configurou". A lição está escrita no
    // `ConfigOperacaoService` desde a SPEC-031.
    const corpo = res.body as { porMes: number; validadeDias: number };
    expect(corpo.porMes).toBe(2);
    expect(corpo.validadeDias).toBe(30);
  });

  it('o clube configurado vence o padrão', async () => {
    const token = await comoAluno();
    prisma.configOperacaoEmpresa.findUnique.mockResolvedValue({
      reposicoesPorMes: 5,
      reposicaoValidadeDias: 60,
    });

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({ porMes: 5, validadeDias: 60 });
  });

  // =====================================================================
  // O papel — D3 e LIM-046e
  // =====================================================================

  it('**o GESTOR não alcança nenhuma das rotas** (LIM-046e)', async () => {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    // O gesto é do aluno (D3). E o mecanismo é `@Roles('aluno')` em cada
    // método, **não** o prefixo `/me/`: o `RolesGuard` diz de si mesmo, em
    // comentário, que deixa passar qualquer role autenticada sem o decorator.
    for (const [metodo, caminho] of [
      ['get', ROTA],
      ['get', `${ROTA}/oportunidades`],
      ['post', ROTA],
    ] as const) {
      await request(app.getHttpServer())
        [metodo](caminho)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(403);
    }
  });

  it('o PROFESSOR também não', async () => {
    const usuario = await buildUsuarioAtivo({ role: 'professor' });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('sem token, 401', async () => {
    await request(app.getHttpServer()).get(ROTA).expect(401);
  });

  // =====================================================================
  // O corpo
  // =====================================================================

  it('corpo sem os dois ids é 400', async () => {
    const token = await comoAluno();

    for (const corpo of [
      {},
      { faltaId: ALUNO_ID },
      { ocupacaoId: ALUNO_ID },
      { faltaId: 'nao-e-uuid', ocupacaoId: ALUNO_ID },
    ]) {
      await request(app.getHttpServer())
        .post(ROTA)
        .set('Authorization', `Bearer ${token}`)
        .send(corpo)
        .expect(400);
    }
  });

  it('**campo a mais no corpo é 400** — não há `alunoId` de terceiro', async () => {
    const token = await comoAluno();

    // `forbidNonWhitelisted` é garantia de TIPO, não de vigilância: sem ela,
    // um `alunoId` no corpo seria ignorado em silêncio hoje e viraria uma
    // porta no dia em que alguém o lesse.
    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send({
        faltaId: ALUNO_ID,
        ocupacaoId: ALUNO_ID,
        alunoId: '11111111-1111-4111-8111-111111111111',
      })
      .expect(400);
  });

  it('UUID em MAIÚSCULAS passa pela VALIDAÇÃO — não vira 400', async () => {
    const token = await comoAluno();

    // **A asserção é "não é 400", e não um status exato.** O que esta camada
    // garante é a fronteira: `@UuidNoCorpo()` aceita e normaliza a caixa
    // (`@IsUUID` sozinho aceitaria maiúsculas e deixaria o id divergir da
    // coluna). O que acontece depois depende de quanto do caminho o dublê
    // cobre, e afirmar `404` aqui seria medir o mock, não a regra.
    const res = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send({
        faltaId: ALUNO_ID.toUpperCase(),
        ocupacaoId: ALUNO_ID.toUpperCase(),
      });

    expect(res.status).not.toBe(400);
  });
});

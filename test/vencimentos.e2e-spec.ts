import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-045 — a lista de vencimentos na camada HTTP.
 *
 * **O que este arquivo prova, e o que ele NÃO prova.** Aqui vivem as decisões
 * que só existem no HTTP: a validação da janela (AC-003), o papel que alcança
 * a rota, e o formato dos dois grupos. Que a consulta não confunda **upgrade**
 * com vencimento (AC-004/AC-005) está em `spec-045-vencimento.db-spec.ts` — é
 * agrupamento sobre dados reais, e um mock que devolve a lista que eu escrevi
 * provaria só que eu sei escrever listas.
 */
const ROTA = '/api/v1/matriculas/vencimentos';

describe('Vencimentos (e2e) — SPEC-045', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoAdmin() {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.matricula.findMany.mockResolvedValue([]);
    return accessToken;
  }

  it('AC-001: responde 200 com os dois grupos', async () => {
    const token = await comoAdmin();

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const corpo = bodyOf<{
      dias: number;
      vencidas: unknown[];
      vencendo: unknown[];
    }>(res);
    expect(corpo.vencidas).toEqual([]);
    expect(corpo.vencendo).toEqual([]);
  });

  it('AC-003: sem `dias`, a janela é 30 — e a resposta ECOA', async () => {
    const token = await comoAdmin();

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // O eco existe para a tela não precisar repetir o padrão do servidor. Sem
    // ele, mudar o padrão aqui deixaria a tela mentindo sobre o que mostra.
    expect(bodyOf<{ dias: number }>(res).dias).toBe(30);
  });

  it('AC-003: `dias` fora de 1..365 é 400', async () => {
    const token = await comoAdmin();

    for (const dias of ['0', '366', '-5', 'abc']) {
      await request(app.getHttpServer())
        .get(`${ROTA}?dias=${dias}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    }
  });

  it('`dias` válido chega ao serviço, e volta ecoado', async () => {
    const token = await comoAdmin();

    const res = await request(app.getHttpServer())
      .get(`${ROTA}?dias=7`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(bodyOf<{ dias: number }>(res).dias).toBe(7);
  });

  it('**a consulta é escopada pela empresa do TOKEN**', async () => {
    const token = await comoAdmin();

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // O escopo nunca vem do cliente (regra do projeto). Sem esta asserção, um
    // `where` sem `companyId` passaria em todos os outros casos deste arquivo
    // — e vazaria a lista de renovação de um clube para outro.
    const [args] = prisma.matricula.findMany.mock.calls[0] as [
      { where: { companyId?: string; aluno?: unknown } },
    ];
    expect(args.where.companyId).toBeDefined();
    // AC-006 — e o desligado fica de fora já no `where`, não depois.
    expect(args.where.aluno).toEqual({ status: 'ativo' });
  });

  it('o ALUNO não alcança a rota', async () => {
    const usuario = await buildUsuarioAtivo({ role: 'aluno' });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    // É a lista comercial do clube inteiro: nomes de quem está devendo
    // renovação. `CompanyAdminGuard` responde `403`.
    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('sem token, 401', async () => {
    await request(app.getHttpServer()).get(ROTA).expect(401);
  });
});

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-033/TASK-006 — `GET /me/creditos`.
 *
 * **Duas coisas só existem nesta camada**, e são as duas que este arquivo
 * prova: o `motivo` **não sai** na resposta do aluno (AC-013), e usuário sem
 * linha de aluno recebe **`404`**, não `200` com zero (AC-012b/PA-09).
 *
 * A primeira é a que importa guardar com teste: esconder por projeção é
 * correto e **silencioso** — no dia em que alguém trocar o `select` por um
 * `findMany` sem `select`, nada quebra e a nota interna do clube aparece no
 * app do aluno.
 */
const ROTA = '/api/v1/me/creditos';

describe('Créditos do aluno (e2e) — SPEC-033/TASK-006', () => {
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
    return accessToken;
  }

  it('AC-012: devolve saldo e extrato', async () => {
    const accessToken = await comoAluno();
    prisma.aluno.findFirst.mockResolvedValue({
      id: 'a1',
      saldoCreditos: 4000,
    });
    prisma.movimentoDeCredito.findMany.mockResolvedValue([
      {
        id: 'm1',
        tipo: 'consumo',
        valorCentavos: 8000,
        ocupacaoId: 'o1',
        criadoEm: new Date('2026-09-08T13:00:00.000Z'),
      },
    ]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(bodyOf(resposta)).toEqual({
      saldoCentavos: 4000,
      movimentos: [
        {
          id: 'm1',
          tipo: 'consumo',
          valorCentavos: 8000,
          ocupacaoId: 'o1',
          criadoEm: '2026-09-08T13:00:00.000Z',
        },
      ],
    });
  });

  it('AC-013: o `motivo` NÃO sai, e a projeção é que garante', async () => {
    const accessToken = await comoAluno();
    prisma.aluno.findFirst.mockResolvedValue({ id: 'a1', saldoCreditos: 0 });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // A garantia é o `select` não pedir o campo — não um `delete` depois de
    // ler. Campo que nunca sai do banco não vaza numa serialização futura.
    const [args] = prisma.movimentoDeCredito.findMany.mock.calls[0] as [
      { select: Record<string, boolean> },
    ];
    expect(args.select).not.toHaveProperty('motivo');
  });

  it('AC-012b (PA-09): usuário sem linha de aluno recebe 404, não 200 com zero', async () => {
    const accessToken = await comoAluno();
    prisma.aluno.findFirst.mockResolvedValue(null);

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);

    // `200` com saldo zero mentiria: não é que a carteira esteja vazia, é que
    // ela não existe. E o extrato nem chega a ser consultado.
    expect(prisma.movimentoDeCredito.findMany).not.toHaveBeenCalled();
  });

  it('a consulta é escopada pela empresa E pelo usuário do token', async () => {
    const accessToken = await comoAluno();
    prisma.aluno.findFirst.mockResolvedValue({ id: 'a1', saldoCreditos: 0 });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [args] = prisma.aluno.findFirst.mock.calls[0] as [
      { where: { usuarioId: string; companyId: string } },
    ];
    expect(args.where.usuarioId).toBe('u-aluno');
    expect(args.where.companyId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('o gestor NÃO usa esta rota — ele tem a do aluno pelo id', async () => {
    const admin = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, admin);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });
});

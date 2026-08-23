import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

// TEST-012 (SPEC-012): a agenda na camada HTTP real — guards, controller e
// service de verdade, só o Prisma mockado.

describe('Agenda (e2e) - TEST-012', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/agenda', () => {
    it('AC-009: a consulta é escopada pela empresa do token, não por parâmetro', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

      await request(app.getHttpServer())
        .get('/api/v1/agenda?mes=2026-08')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const [args] = prisma.ocupacaoQuadra.groupBy.mock.calls[0] as [
        { where: { companyId: string } },
      ];
      // O `companyId` sai do JWT. Um cliente que mandasse outro na query
      // não teria efeito nenhum — o guard autoriza a rota, o filtro
      // protege o dado, e os dois precisam existir.
      expect(args.where.companyId).toBe(usuario.companyId);
    });

    it('AC-006: aluno não acessa a agenda do gestor', async () => {
      const aluno = await buildUsuarioAtivo({
        id: 'u-aluno',
        email: 'aluno@x.com',
        role: 'aluno',
      });
      const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

      await request(app.getHttpServer())
        .get('/api/v1/agenda?mes=2026-08')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('rejeita mês em formato inválido antes de tocar o banco', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
      prisma.ocupacaoQuadra.groupBy.mockClear();

      await request(app.getHttpServer())
        .get('/api/v1/agenda?mes=agosto')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(prisma.ocupacaoQuadra.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/agenda/:data', () => {
    it('AC-004: ocupação de turma é identificada pela turma, não pelo aluno', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
      prisma.ocupacaoQuadra.findMany.mockResolvedValue([
        {
          id: 'o1',
          quadra: { nome: 'Quadra 1' },
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
          origemTipo: 'TURMA',
          aluno: null,
          origemTurma: { nome: 'Turma das 14h' },
          statusPagamento: 'pendente_pagamento',
        },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/v1/agenda/2026-08-24')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(bodyOf<{ responsavel: string }[]>(res)[0].responsavel).toBe(
        'Turma das 14h',
      );
    });
  });

  // AC-013 — a corrida que a validação cruzada apontou: dois admins com o
  // mesmo dia aberto, um cancela e o outro marca pago na mesma linha.
  describe('corrida cancelar × marcar pago (AC-013)', () => {
    // A rota valida o id com ParseUUIDPipe — usar 'o1' devolveria 400
    // antes de chegar na regra que o teste quer provar.
    const OCUPACAO_ID = '3f1a9a2e-1f4b-4c2a-9a1e-0a1b2c3d4e5f';

    it('marcar pago numa reserva já cancelada devolve 422, sem escrita', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
      prisma.ocupacaoQuadra.findFirst.mockResolvedValue({
        id: OCUPACAO_ID,
        companyId: usuario.companyId,
        origemTipo: 'AVULSO',
        statusPagamento: 'cancelado',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/bookings/${OCUPACAO_ID}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'pago' })
        .expect(422);

      expect(bodyOf<{ code: string }>(res).code).toBe('RESERVA_CANCELADA');
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });

    it('marcar pago numa ocupação de turma devolve 422, sem escrita', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
      prisma.ocupacaoQuadra.findFirst.mockResolvedValue({
        id: OCUPACAO_ID,
        companyId: usuario.companyId,
        origemTipo: 'TURMA',
        statusPagamento: 'pendente_pagamento',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/bookings/${OCUPACAO_ID}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'pago' })
        .expect(422);

      expect(bodyOf<{ code: string }>(res).code).toBe('OCUPACAO_DE_TURMA');
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });
  });
});

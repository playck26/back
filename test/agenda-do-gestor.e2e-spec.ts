import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-057/TASK-005 (card 5349) — **as duas fronteiras HTTP novas da agenda
 * do gestor**, com guards, pipes e `ValidationPipe` de verdade; só o Prisma
 * mockado. A regra de cada uma já tem prova em banco; aqui se prova o que só
 * a camada HTTP decide:
 *
 * - `GET /agenda/ocorrencias/:ocupacaoId/visitantes`: papel, UUID malformado
 *   e 404 — antes de tocar o banco quando é o caso;
 * - `POST`/`PATCH /courts`: o código da quadra NÃO é aceito no corpo
 *   (`forbidNonWhitelisted`) e a cor inválida sai com `code`, não com a lista
 *   genérica do `ValidationPipe`. Lição do DEF-034: contrato de rota que
 *   ninguém exercitou por HTTP é contrato que ninguém mediu.
 */
const OCUPACAO = '0b0e0000-0000-4000-8000-000000000001';
const QUADRA = '0b0e0000-0000-4000-8000-000000000002';

describe('Agenda do gestor (e2e) — SPEC-057/TASK-005', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function token(role: 'company_admin' | 'aluno' = 'company_admin') {
    const usuario = await buildUsuarioAtivo({
      id: `u-${role}`,
      email: `${role}@empresa.demo`,
      role,
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return { accessToken, companyId: usuario.companyId };
  }

  describe('GET /agenda/ocorrencias/:ocupacaoId/visitantes', () => {
    const rota = `/api/v1/agenda/ocorrencias/${OCUPACAO}/visitantes`;

    it('gestor recebe nome e nível dos visitantes, com as cinco chaves e nada mais', async () => {
      const { accessToken, companyId } = await token();
      prisma.ocupacaoQuadra.findFirst.mockResolvedValue({ id: OCUPACAO });
      prisma.reposicaoDeAula.findMany.mockResolvedValue([
        {
          alunoId: '0b0e0000-0000-4000-8000-0000000000a1',
          aluno: {
            nivelId: null,
            nivel: null,
            usuario: { nome: 'Ana' },
          },
        },
      ]);

      const res = await request(app.getHttpServer())
        .get(rota)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const corpo = bodyOf<Record<string, unknown>[]>(res);
      expect(corpo).toHaveLength(1);
      expect(Object.keys(corpo[0]).sort()).toEqual(
        ['alunoId', 'nivelId', 'nivelNome', 'nome', 'tipo'].sort(),
      );
      const [args] = prisma.ocupacaoQuadra.findFirst.mock.calls[0] as [
        { where: { companyId: string } },
      ];
      expect(args.where.companyId).toBe(companyId);
    });

    it('ocorrência que o escopo não encontra → 404', async () => {
      const { accessToken } = await token();
      prisma.ocupacaoQuadra.findFirst.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get(rota)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('UUID malformado → 400, sem tocar o banco', async () => {
      const { accessToken } = await token();
      prisma.ocupacaoQuadra.findFirst.mockClear();

      await request(app.getHttpServer())
        .get('/api/v1/agenda/ocorrencias/banana/visitantes')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(prisma.ocupacaoQuadra.findFirst).not.toHaveBeenCalled();
    });

    it('aluno não alcança a rota → 403', async () => {
      const { accessToken } = await token('aluno');

      await request(app.getHttpServer())
        .get(rota)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('cor e código da quadra pela API', () => {
    it('PATCH com `codigoAgenda` no corpo → 400: o código não é editável', async () => {
      const { accessToken } = await token();
      prisma.quadra.findFirst.mockResolvedValue({ status: 'ativa' });

      await request(app.getHttpServer())
        .patch(`/api/v1/courts/${QUADRA}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ codigoAgenda: '99' })
        .expect(400);
    });

    it.each([
      ['null', null],
      ['fora da paleta', '#FF0000'],
      ['formato inválido', 'verde'],
    ])('PATCH com cor %s → 400 COR_QUADRA_INVALIDA', async (_caso, cor) => {
      const { accessToken } = await token();
      prisma.quadra.findFirst.mockResolvedValue({ status: 'ativa' });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/courts/${QUADRA}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cor })
        .expect(400);

      expect(bodyOf<{ code: string }>(res).code).toBe('COR_QUADRA_INVALIDA');
    });

    it('POST com cor fora da paleta → 400 COR_QUADRA_INVALIDA', async () => {
      const { accessToken } = await token();

      const res = await request(app.getHttpServer())
        .post('/api/v1/courts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          nome: 'Nova',
          esporteId: '0b0e0000-0000-4000-8000-0000000000e1',
          precoHora: 80,
          cor: '#123456',
        })
        .expect(400);

      expect(bodyOf<{ code: string }>(res).code).toBe('COR_QUADRA_INVALIDA');
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';
import { ClassesService } from '../src/classes/classes.service';
import { CourtsService } from '../src/courts/courts.service';

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

      // SPEC-060 — o resumo do mês virou `$queryRaw` (o `groupBy` não
      // expressa "AVULSO sem professor"), então o escopo agora é um PARÂMETRO
      // LIGADO, não uma chave de objeto. O que a prova afirma não mudou: o
      // `companyId` sai do JWT, e um cliente que mandasse outro na query não
      // teria efeito nenhum — o guard autoriza a rota, o filtro protege o
      // dado, e os dois precisam existir.
      const chamadas = prisma.$queryRaw.mock.calls as unknown[][];
      const doMes = chamadas.find((c) =>
        String((c[0] as string[]).join(' ')).includes('ocupacoes_quadra'),
      );
      expect(doMes).toBeDefined();
      expect(doMes!.slice(1)).toContain(usuario.companyId);
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
      prisma.$queryRaw.mockClear();

      await request(app.getHttpServer())
        .get('/api/v1/agenda?mes=agosto')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
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
          // SPEC-054/D12 — o include do item do dia traz os adicionais.
          adicionais: [],
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

  /**
   * SPEC-077/TASK-005 — **o #46 da 077: `/agenda/semana` não tinha teste
   * HTTP.** A `EVD-034-001` apontava para este arquivo, e nenhum caso dele
   * chamava a rota (conferido por `grep` em 2026-09-27).
   */
  describe('SPEC-077 — GET /agenda/semana (034 AC-002/003)', () => {
    /**
     * **`400`, e não o `422` que a 034 escreveu** — a mesma convenção do #32:
     * falha de `class-validator` é `400` no projeto inteiro (SPEC-036), e o
     * próprio `DataDoCalendarioConstraint` diz "a entrada errada é `400`".
     */
    it.each(['2026-02-30', 'banana', '2026-09-10T12:00:00Z'])(
      'AC-002: inicio=%s ⇒ 400, sem consultar ocupações',
      async (inicio) => {
        const usuario = await buildUsuarioAtivo();
        const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
        prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
        prisma.ocupacaoQuadra.findMany.mockClear();

        const res = await request(app.getHttpServer())
          .get(`/api/v1/agenda/semana?inicio=${encodeURIComponent(inicio)}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(400);

        expect(JSON.stringify(bodyOf(res))).toContain('calendário');
        expect(prisma.ocupacaoQuadra.findMany).not.toHaveBeenCalled();
      },
    );

    it('AC-003: `/agenda/semana?inicio=2026-09-06` ⇒ 200 com os 7 dias — a rota casa ANTES de `:data`', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

      const res = await request(app.getHttpServer())
        .get('/api/v1/agenda/semana?inicio=2026-09-06')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(bodyOf<{ data: string }[]>(res).map((d) => d.data)).toEqual([
        '2026-09-06',
        '2026-09-07',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
      ]);
    });
  });

  /**
   * SPEC-077/TASK-003 — **as provas por HTTP que a matriz da SPEC-034
   * prometia** (AC-005, AC-009 e AC-014 da 034; #20, #24 e #32 da 077).
   */
  describe('SPEC-077 — mover e cancelar pela rota (034 AC-005/009/014)', () => {
    const OCUPACAO_ID = '3f1a9a2e-1f4b-4c2a-9a1e-0a1b2c3d4e5f';
    const TURMA_ID = '6b0d7c1e-2a3f-4b5c-8d9e-0f1a2b3c4d5e';

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('#20: `{}` ⇒ 422 NADA_A_MOVER, ANTES de qualquer acesso ao banco', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
      // O login e o guard leem `usuarios`; o que não pode acontecer é tocar
      // em `ocupacoes_quadra` ou abrir transação.
      prisma.$transaction.mockClear();
      prisma.$queryRaw.mockClear();
      prisma.ocupacaoQuadra.findFirst.mockClear();

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/bookings/${OCUPACAO_ID}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(422);

      expect(bodyOf<{ code: string }>(res).code).toBe('NADA_A_MOVER');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.ocupacaoQuadra.findFirst).not.toHaveBeenCalled();
    });

    it('#24: ALUNO no `PATCH /bookings/:id` ⇒ 403, sem chamar o serviço', async () => {
      const mover = jest.spyOn(CourtsService.prototype, 'moveBooking');
      const aluno = await buildUsuarioAtivo({
        id: 'u-aluno',
        email: 'aluno@x.com',
        role: 'aluno',
      });
      const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

      await request(app.getHttpServer())
        .patch(`/api/v1/bookings/${OCUPACAO_ID}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ horaInicio: '10:00', horaFim: '11:00' })
        .expect(403);

      expect(mover).not.toHaveBeenCalled();
    });

    /**
     * #32 — **`400`, e não o `422` que a 034 escreveu.** O projeto inteiro
     * responde `400` para falha de `class-validator` (SPEC-036:
     * `configurar-app.ts` não define `errorHttpStatusCode`), e mudar só esta
     * rota contrariaria a convenção de todas as outras. A 034 ganha a nota.
     *
     * Os dois controles (3 e 280 caracteres) chegam ao serviço: sem eles, o
     * `400` poderia vir de outra coisa no corpo, e não do tamanho do motivo.
     */
    it.each([
      ['sem motivo', {}],
      ['motivo de 2 caracteres', { motivo: 'ab' }],
      ['motivo de 281 caracteres', { motivo: 'x'.repeat(281) }],
    ])(
      '#32: cancelar aula %s ⇒ 400, sem chamar o serviço',
      async (_c, corpo) => {
        const cancelar = jest.spyOn(
          ClassesService.prototype,
          'cancelarOcorrencia',
        );
        const usuario = await buildUsuarioAtivo();
        const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
        prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/classes/${TURMA_ID}/ocorrencias/${OCUPACAO_ID}/cancel`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send(corpo)
          .expect(400);

        expect(JSON.stringify(bodyOf(res))).toContain('motivo');
        expect(cancelar).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['3 caracteres', 'abc'],
      ['280 caracteres', 'x'.repeat(280)],
    ])(
      '#32 (controle): motivo de %s chega ao serviço, com o texto',
      async (_c, motivo) => {
        const cancelar = jest
          .spyOn(ClassesService.prototype, 'cancelarOcorrencia')
          .mockResolvedValue(undefined);
        const usuario = await buildUsuarioAtivo();
        const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
        prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

        await request(app.getHttpServer())
          .post(`/api/v1/classes/${TURMA_ID}/ocorrencias/${OCUPACAO_ID}/cancel`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ motivo })
          .expect(204);

        expect(cancelar).toHaveBeenCalledWith(
          usuario.companyId,
          TURMA_ID,
          OCUPACAO_ID,
          motivo,
          usuario.id,
        );
      },
    );
  });
});

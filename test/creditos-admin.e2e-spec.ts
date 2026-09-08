import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  buildUsuarioAtivo,
  loginAndGetTokens,
  SENHA_VALIDA,
} from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-033/TASK-004 — as rotas administrativas da carteira, na camada HTTP.
 *
 * **O que este arquivo prova, e o que ele NÃO prova.** Aqui o Prisma é
 * mockado: o que se exercita é guard, controller, DTO e o caminho da senha —
 * as decisões que só existem no HTTP. O comportamento do ledger (trigger,
 * `CHECK` do motivo, FK causal, `FOR UPDATE`) é provado contra Postgres real
 * em `test/banco/creditos-service.db-spec.ts`, porque mock não tem trigger.
 *
 * A divisão importa: um e2e com mock que "provasse" o saldo estaria provando
 * o mock.
 */
const ALUNO = '22222222-2222-4222-8222-222222222222';
const ROTA = `/api/v1/students/${ALUNO}/creditos`;

describe('Créditos — rotas do admin (e2e) — SPEC-033/TASK-004', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  /** Loga como `company_admin` e arma o `findUnique` que o guard e a rota leem. */
  async function comoAdmin() {
    const usuario = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    // O guard lê `senhaTemporaria`; a rota lê `senhaHash`. É o MESMO
    // `findUnique`, então os dois campos vão juntos — separar exigiria
    // ramificar o mock por `select`, que é armadilha conhecida aqui.
    prisma.usuario.findUnique.mockResolvedValue({
      senhaTemporaria: false,
      senhaHash: usuario.senhaHash,
    });
    return accessToken;
  }

  it('AC-001: lança crédito e devolve o movimento criado', async () => {
    const accessToken = await comoAdmin();
    prisma.aluno.findUnique.mockResolvedValue({ saldoCreditos: 20_000 });

    const resposta = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'entrada',
        valorCentavos: 20_000,
        motivo: 'aporte inicial',
        senha: SENHA_VALIDA,
      })
      .expect(201);

    expect(bodyOf(resposta)).toEqual({
      movimentoId: 'movimento-1',
      saldoCentavos: 20_000,
    });

    // A ação administrativa nasce com o tipo certo e DENTRO da transação —
    // é o gesto humano da SPEC-032, e sem ela a FK do movimento recusaria.
    const [args] = prisma.tx.acaoAdministrativa.create.mock.calls[0] as [
      { data: { tipo: string; motivo: string } },
    ];
    expect(args.data.tipo).toBe('credito_lancado');
    expect(args.data.motivo).toBe('aporte inicial');
  });

  it('a retirada usa o outro tipo de ação', async () => {
    const accessToken = await comoAdmin();
    // A retirada confere o saldo sob `FOR UPDATE` antes de inserir — no mock
    // quem responde é o `$queryRaw` do tx.
    prisma.tx.$queryRaw.mockResolvedValue([{ saldo_creditos: 50_000 }]);

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'retirada',
        valorCentavos: 10_000,
        motivo: 'estorno',
        senha: SENHA_VALIDA,
      })
      .expect(201);

    const [args] = prisma.tx.acaoAdministrativa.create.mock.calls[0] as [
      { data: { tipo: string } },
    ];
    expect(args.data.tipo).toBe('credito_retirado');
  });

  it('AC-002: senha errada devolve 422 SENHA_INVALIDA e NÃO grava nada', async () => {
    const accessToken = await comoAdmin();

    const resposta = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'entrada',
        valorCentavos: 5_000,
        motivo: 'tentativa',
        senha: 'senha-errada',
      })
      .expect(422);

    expect(bodyOf<{ code: string }>(resposta).code).toBe('SENHA_INVALIDA');
    // **Não grava nada** é metade do AC. A senha é conferida FORA da
    // transação de propósito: assim "não gravou" é estrutural, não depende
    // de o rollback ter funcionado.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tx.acaoAdministrativa.create).not.toHaveBeenCalled();
  });

  it('PA-06: a recusa de senha é 422, NUNCA 401 — o 401 deslogaria o admin', async () => {
    const accessToken = await comoAdmin();

    const resposta = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'entrada',
        valorCentavos: 5_000,
        motivo: 'tentativa',
        senha: 'senha-errada',
      });

    // A asserção é sobre o número: o `authFetch` dos três frontends trata
    // `401` como sessão expirada e desloga. Trocar este status por `401`
    // transformaria erro de digitação em perda de contexto.
    expect(resposta.status).not.toBe(401);
    expect(resposta.status).toBe(422);
  });

  it('AC-004: retirada acima do saldo é 422 SALDO_INSUFICIENTE', async () => {
    const accessToken = await comoAdmin();
    prisma.tx.$queryRaw.mockResolvedValue([{ saldo_creditos: 1_000 }]);

    const resposta = await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'retirada',
        valorCentavos: 9_999,
        motivo: 'acima do saldo',
        senha: SENHA_VALIDA,
      })
      .expect(422);

    expect(bodyOf<{ code: string }>(resposta).code).toBe('SALDO_INSUFICIENTE');
    expect(prisma.tx.movimentoDeCredito.create).not.toHaveBeenCalled();
  });

  it('o DTO recusa `consumo` pela rota humana — ele nasce da reserva', async () => {
    const accessToken = await comoAdmin();

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'consumo',
        valorCentavos: 1_000,
        motivo: 'não devia passar',
        senha: SENHA_VALIDA,
      })
      .expect(400);
  });

  it('D3: valor negativo é recusado — o sinal vem do tipo, não do valor', async () => {
    const accessToken = await comoAdmin();

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'entrada',
        valorCentavos: -500,
        motivo: 'entrada negativa',
        senha: SENHA_VALIDA,
      })
      .expect(400);
  });

  it('AC-013: o extrato do ADMIN traz `motivo` — é o do aluno que esconde', async () => {
    const accessToken = await comoAdmin();
    prisma.aluno.findFirst.mockResolvedValue({ saldoCreditos: 12_000 });
    prisma.movimentoDeCredito.findMany.mockResolvedValue([
      {
        id: 'm1',
        tipo: 'entrada',
        valorCentavos: 12_000,
        motivo: 'cheque devolvido',
        ocupacaoId: null,
        criadoEm: new Date('2026-09-08T12:00:00.000Z'),
      },
    ]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(bodyOf(resposta)).toEqual({
      saldoCentavos: 12_000,
      movimentos: [
        {
          id: 'm1',
          tipo: 'entrada',
          valorCentavos: 12_000,
          motivo: 'cheque devolvido',
          ocupacaoId: null,
          criadoEm: '2026-09-08T12:00:00.000Z',
        },
      ],
    });
  });

  it('a consulta é escopada pela empresa do TOKEN', async () => {
    const accessToken = await comoAdmin();

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [args] = prisma.movimentoDeCredito.findMany.mock.calls[0] as [
      { where: { companyId: string; alunoId: string } },
    ];
    expect(args.where.alunoId).toBe(ALUNO);
    expect(args.where.companyId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('o aluno NÃO alcança a carteira de ninguém por esta rota', async () => {
    const aluno = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'aluno@empresa.demo',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        tipo: 'entrada',
        valorCentavos: 1_000,
        motivo: 'aluno tentando',
        senha: SENHA_VALIDA,
      })
      .expect(403);
  });
});

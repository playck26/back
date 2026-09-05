import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  buildUsuarioAtivo,
  COMPANY_ID,
  loginAndGetTokens,
} from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * TEST-031/TASK-003 — as três rotas da configuração de operação.
 *
 * Prisma mockado: o que esta suíte isola é a camada HTTP — guard, DTO e
 * status. O CHECK do banco (`IS NULL OR >= 1`) é a **segunda** barreira e tem
 * prova própria; aqui se prova que o zero nem chega lá.
 */

interface Config {
  prazoCancelamentoAulaHoras: number | null;
  prazoCancelamentoReservaHoras: number | null;
}

const ROTA_GESTOR = '/api/v1/company-settings/operacao';
const ROTA_ALUNO = '/api/v1/me/company/operacao';

describe('SPEC-031 — configuração de operação (REQ-001, REQ-002)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  // `buildUsuarioAtivo` e ASSINCRONA (faz bcrypt do hash). Passar a promessa
  // direto faz o login receber `email: undefined` e responder 400 — falha que
  // aponta para o login e nao para a rota em teste.
  const comoGestor = async () => {
    const t = await loginAndGetTokens(app, prisma, await buildUsuarioAtivo());
    return t.accessToken;
  };

  const comoAluno = async () => {
    const t = await loginAndGetTokens(
      app,
      prisma,
      await buildUsuarioAtivo({
        id: 'a1',
        email: 'aluno@empresa.demo',
        role: 'aluno',
      }),
    );
    // Depois do login, `usuario.findUnique` volta a ser consultado pelo guard
    // de senha temporaria. `loginAndGetTokens` o deixa apontando para o
    // usuario inteiro, que nao tem o campo — e `undefined` vira 403. Mesmo
    // passo de `agenda.e2e-spec.ts:52`.
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return t.accessToken;
  };

  describe('AC-001 — PUT grava, GET lê', () => {
    it('PUT devolve o que gravou, e o upsert é escopado pela empresa do token', async () => {
      const token = await comoGestor();
      prisma.configOperacaoEmpresa.upsert.mockResolvedValue({
        prazoCancelamentoAulaHoras: 2,
        prazoCancelamentoReservaHoras: 4,
      });

      const res = await request(app.getHttpServer())
        .put(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .send({
          prazoCancelamentoAulaHoras: 2,
          prazoCancelamentoReservaHoras: 4,
        })
        .expect(200);

      expect(bodyOf<Config>(res)).toEqual({
        prazoCancelamentoAulaHoras: 2,
        prazoCancelamentoReservaHoras: 4,
      });

      // O `companyId` vem do TOKEN, nunca do corpo — não há id na URL para
      // alguém trocar.
      const chamadas = prisma.configOperacaoEmpresa.upsert.mock.calls as Array<
        [{ where: { companyId: string } }]
      >;
      expect(chamadas[0][0].where.companyId).toBe(COMPANY_ID);
    });

    it('GET devolve o que está gravado', async () => {
      const token = await comoGestor();
      prisma.configOperacaoEmpresa.findUnique.mockResolvedValue({
        prazoCancelamentoAulaHoras: 3,
        prazoCancelamentoReservaHoras: null,
      });

      const res = await request(app.getHttpServer())
        .get(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(bodyOf<Config>(res)).toEqual({
        prazoCancelamentoAulaHoras: 3,
        prazoCancelamentoReservaHoras: null,
      });
    });

    /**
     * AC-003 — empresa sem configuração é o estado normal, e a maioria hoje.
     * `404` obrigaria cada chamador a traduzir "não encontrado" em "sem
     * prazo", e é nessa tradução que o `null` viraria `0`.
     */
    it('AC-003: empresa SEM configuracao devolve os dois null, nao 404', async () => {
      const token = await comoGestor();
      prisma.configOperacaoEmpresa.findUnique.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(bodyOf<Config>(res)).toEqual({
        prazoCancelamentoAulaHoras: null,
        prazoCancelamentoReservaHoras: null,
      });
    });
  });

  describe('AC-002 — inteiro >= 1 ou null, e o resto e 400', () => {
    const casos: Array<[string, unknown]> = [
      ['zero', 0],
      ['negativo', -1],
      ['fracionario', 1.5],
      ['texto', '2'],
    ];

    it.each(casos)('%s no prazo de aula sai em 400', async (_nome, valor) => {
      const token = await comoGestor();
      await request(app.getHttpServer())
        .put(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .send({
          prazoCancelamentoAulaHoras: valor,
          prazoCancelamentoReservaHoras: null,
        })
        .expect(400);
      expect(prisma.configOperacaoEmpresa.upsert).not.toHaveBeenCalled();
    });

    it('null nos DOIS e aceito — e a unica ausencia (INV-065)', async () => {
      const token = await comoGestor();
      prisma.configOperacaoEmpresa.upsert.mockResolvedValue({
        prazoCancelamentoAulaHoras: null,
        prazoCancelamentoReservaHoras: null,
      });

      await request(app.getHttpServer())
        .put(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .send({
          prazoCancelamentoAulaHoras: null,
          prazoCancelamentoReservaHoras: null,
        })
        .expect(200);
    });

    /**
     * `PUT` é substituição total: mandar um campo só é ambíguo entre "deixe
     * como está" e "tire o prazo", e as duas leituras mudam quem consegue
     * cancelar.
     */
    it('corpo com um campo so e recusado — PUT e substituicao total', async () => {
      const token = await comoGestor();
      await request(app.getHttpServer())
        .put(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .send({ prazoCancelamentoAulaHoras: 2 })
        .expect(400);
    });
  });

  describe('REQ-002 — a rota do aluno', () => {
    it('AC-004: aluno le por /me/company/operacao', async () => {
      const token = await comoAluno();
      prisma.configOperacaoEmpresa.findUnique.mockResolvedValue({
        prazoCancelamentoAulaHoras: 2,
        prazoCancelamentoReservaHoras: 4,
      });

      const res = await request(app.getHttpServer())
        .get(ROTA_ALUNO)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(bodyOf<Config>(res).prazoCancelamentoAulaHoras).toBe(2);
    });

    it('o aluno NAO escreve: a rota do gestor lhe da 403', async () => {
      const token = await comoAluno();
      await request(app.getHttpServer())
        .put(ROTA_GESTOR)
        .set('Authorization', `Bearer ${token}`)
        .send({
          prazoCancelamentoAulaHoras: 2,
          prazoCancelamentoReservaHoras: 4,
        })
        .expect(403);
    });

    /**
     * AC-005 — **o campo não entra em `GET /me/company`.** Aquele 200 já
     * existe e é cacheado em módulo no cliente: um back antigo responderia
     * 200 sem o campo, e a tela não teria como distinguir "empresa sem
     * prazo" de "back ainda não atualizado". A rota nova dá 404 no back
     * antigo, e é esse 404 que o rollout usa como sinal de versão.
     */
    it('AC-005: GET /me/company NAO traz o prazo', async () => {
      const token = await comoAluno();
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        nome: 'Clube',
        slug: 'clube',
        logoKey: null,
        logoUrl: null,
        status: 'ativa',
        permiteAutoCadastro: true,
        limiteTurmasPorAluno: null,
        contratoVersaoVigente: null,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/company')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const corpo = bodyOf<Record<string, unknown>>(res);
      expect(corpo).not.toHaveProperty('prazoCancelamentoAulaHoras');
      expect(corpo).not.toHaveProperty('prazoCancelamentoReservaHoras');
    });
  });
});

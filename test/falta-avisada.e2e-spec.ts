import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-031/REQ-006 — **a camada HTTP das duas rotas de falta avisada.**
 *
 * ## O que esta suíte prova, e o que ela não prova
 *
 * O comportamento está provado contra Postgres real no `fit-018-019-falta-avisada.db-spec.ts`, que chama o
 * serviço direto. **Isso deixa a rota inteira sem prova** — e a rota tem três
 * coisas que nenhum db-spec alcança:
 *
 * 1. **Ela existe e o Nest consegue montá-la.** A DI foi o defeito que passou
 *    por `tsc` limpo e 976 unitários verdes nesta mesma task: `ClassesModule`
 *    não importava `CompanySettingsModule`, e só o e2e viu.
 * 2. **`@Roles('aluno')`.** Sem o decorator o `RolesGuard` diz de si mesmo,
 *    em comentário, que deixa passar qualquer role autenticada — então a
 *    ausência dele não quebra nada visível.
 * 3. **A ORDEM dos dois `:params`.** Trocar `:turmaId` com `:ocupacaoId`
 *    passaria em todos os casos do `fit-018-019`, porque lá a chamada é
 *    direta. Só apareceria em produção.
 *
 * Prisma é mock: o que não se prova aqui são os predicados SQL — e a lição de
 * já ter tentado é que um `WHERE` contra mock prova apenas que o mock
 * concorda comigo.
 */
const TURMA = '11111111-1111-4111-8111-111111111111';
const OCUPACAO = '22222222-2222-4222-8222-222222222222';
const ROTA = `/api/v1/me/classes/${TURMA}/aulas/${OCUPACAO}/falta`;

describe('SPEC-031 — rotas de falta avisada (REQ-006)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

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
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return t.accessToken;
  };

  const comoGestor = async () => {
    const t = await loginAndGetTokens(app, prisma, await buildUsuarioAtivo());
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return t.accessToken;
  };

  const comoProfessor = async () => {
    const t = await loginAndGetTokens(
      app,
      prisma,
      await buildUsuarioAtivo({
        id: 'p1',
        email: 'prof@empresa.demo',
        role: 'professor',
      }),
    );
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return t.accessToken;
  };

  it('POST responde 204 e chega ao serviço com os params na ORDEM certa', async () => {
    const token = await comoAluno();

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // A matrícula é consultada com a TURMA da URL — não com a ocupação.
    const [matricula] = prisma.tx.turmaAluno.findFirst.mock.calls[0] as [
      { where: { turmaId: string; alunoId: string } },
    ];
    expect(matricula.where.turmaId).toBe(TURMA);
    expect(matricula.where.alunoId).toBe('aluno-1');
    // E a linha nasce apontando para a OCUPAÇÃO da URL.
    const [criado] = prisma.tx.faltaAvisada.createMany.mock.calls[0] as [
      {
        data: { ocupacaoId: string; alunoId: string }[];
        skipDuplicates: boolean;
      },
    ];
    expect(criado.data[0].ocupacaoId).toBe(OCUPACAO);
    expect(criado.data[0].alunoId).toBe('aluno-1');
    expect(criado.skipDuplicates).toBe(true);
  });

  /**
   * **Casos escritos pela validação cruzada de 2026-09-06**, mantidos com a
   * autoria dela. O primeiro é o negativo que a minha EVD original não
   * provava; o segundo é o DEF-VC031-01 na camada HTTP.
   */
  it('REVIEW-031: aluno sem matricula recebe 404 e nao grava', async () => {
    const token = await comoAluno();
    prisma.tx.turmaAluno.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(prisma.tx.faltaAvisada.createMany).not.toHaveBeenCalled();
  });

  it('REVIEW-031: PATCH payment-status deve recusar reserva passada com 409', async () => {
    const token = await comoGestor();
    Object.assign(prisma.tx, {
      acaoAdministrativa: {
        create: jest.fn().mockResolvedValue({ id: 'acao-review' }),
      },
      eventoDeOcupacao: { create: jest.fn().mockResolvedValue({}) },
    });
    const base = {
      id: OCUPACAO,
      companyId: 'c1',
      quadraId: TURMA,
      alunoId: 'aluno-1',
      data: new Date('2000-01-01T00:00:00.000Z'),
      horaInicio: new Date('1970-01-01T09:00:00.000Z'),
      horaFim: new Date('1970-01-01T10:00:00.000Z'),
      origemTipo: 'AVULSO',
      statusPagamento: 'pendente_pagamento',
    };
    prisma.ocupacaoQuadra.findFirst.mockResolvedValue(base);
    prisma.ocupacaoQuadra.update.mockResolvedValue({
      ...base,
      statusPagamento: 'cancelado',
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/bookings/${OCUPACAO}/payment-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'cancelado' })
      .expect(409);
  });

  it('DELETE responde 204 e apaga escopado por empresa, ocupação e aluno', async () => {
    const token = await comoAluno();

    await request(app.getHttpServer())
      .delete(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const [apagado] = prisma.tx.faltaAvisada.deleteMany.mock.calls[0] as [
      { where: { companyId: string; ocupacaoId: string; alunoId: string } },
    ];
    expect(apagado.where.ocupacaoId).toBe(OCUPACAO);
    expect(apagado.where.alunoId).toBe('aluno-1');
  });

  /**
   * O gestor não avisa falta por ninguém. Isto não é sobre confiança: o
   * `alunoId` é **derivado do token**, então um gestor autenticado que
   * passasse pela rota criaria a falta em nome de si mesmo — e ele não tem
   * linha em `alunos`. O `403` do guard corta antes de a pergunta existir.
   */
  it.each([
    [
      'POST',
      (s: App, t: string) =>
        request(s).post(ROTA).set('Authorization', `Bearer ${t}`),
    ],
    [
      'DELETE',
      (s: App, t: string) =>
        request(s).delete(ROTA).set('Authorization', `Bearer ${t}`),
    ],
  ])('%s de gestor leva 403 (@Roles aluno)', async (_verbo, chamar) => {
    const token = await comoGestor();
    await chamar(app.getHttpServer(), token).expect(403);
    expect(prisma.tx.faltaAvisada.createMany).not.toHaveBeenCalled();
    expect(prisma.tx.faltaAvisada.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * LIM-031g — **o mecanismo é o `@Roles('aluno')`, não o prefixo `/me/`.**
   * O prefixo é convenção de leitura; ele não decide nada. O professor tem a
   * sua própria visão da falta (a chamada), e criar uma pelo aluno seria
   * registrar aviso que o aluno não deu.
   */
  it('POST de professor leva 403 — o prefixo /me/ não é o mecanismo', async () => {
    const token = await comoProfessor();
    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(prisma.tx.faltaAvisada.createMany).not.toHaveBeenCalled();
  });

  /**
   * D19, o escopo da rota — o `404` chega ao HTTP como `404`.
   *
   * **Que a ocorrência de OUTRA turma seja inalcançável está provado no
   * `fit-018-019`, contra os predicados reais.** Aqui se prova só a metade
   * que é desta camada: quando a consulta não acha, o cliente vê `404` — e
   * não `500`, que é o que uma exceção não mapeada viraria.
   */
  it('ocorrência que não é desta turma leva 404, e nada é escrito', async () => {
    const token = await comoAluno();
    // Os quatro predicados do D19 não casam: nenhuma linha volta.
    prisma.tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('FROM alunos') ? [{ id: 'aluno-1' }] : [],
      ),
    );

    await request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(prisma.tx.faltaAvisada.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', (s: App) => request(s).post(ROTA)],
    ['DELETE', (s: App) => request(s).delete(ROTA)],
  ])('%s sem token leva 401', async (_verbo, chamar) => {
    await chamar(app.getHttpServer()).expect(401);
  });

  it('turmaId que não é UUID leva 400, antes de qualquer consulta', async () => {
    const token = await comoAluno();

    await request(app.getHttpServer())
      .post(`/api/v1/me/classes/nao-e-uuid/aulas/${OCUPACAO}/falta`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

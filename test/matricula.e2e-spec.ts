import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-037 — matrícula na camada HTTP.
 *
 * **O que este arquivo prova:** as três recusas com código e o `403` do
 * `/me/matricula` — decisões que só existem no HTTP. Que o BANCO recuse
 * matrícula sem o contrato aceito está em `spec-037-matricula.db-spec.ts`,
 * com a FK causal e a coluna gerada, porque mock não tem chave estrangeira.
 *
 * **As três recusas existem para não deixar o `23503` virar `500`.** A
 * INV-114 é a garantia; sem elas, o gestor receberia "erro no servidor" em vez
 * de *"este aluno ainda não aceitou o contrato"*. É a mesma divisão de
 * trabalho da `EXCLUDE` e da pré-checagem na INV-001.
 */
const ALUNO_ID = '55555555-5555-4555-8555-555555555555';
const PLANO_ID = '66666666-6666-4666-8666-666666666666';
const ROTA = `/api/v1/students/${ALUNO_ID}/matriculas`;

describe('Matrícula (e2e) — SPEC-037', () => {
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
    prisma.aluno.findFirst.mockResolvedValue({
      id: ALUNO_ID,
      usuarioId: 'u-aluno',
    });
    prisma.plano.findFirst.mockResolvedValue({
      id: PLANO_ID,
      nome: 'Mensal',
      valorCentavos: 30000,
      prazoMeses: 1,
      linkPagamentoUrl: null,
      ativo: true,
    });
    prisma.empresa.findUniqueOrThrow.mockResolvedValue({
      contratoVersaoVigente: 3,
    });
    prisma.aceite.findFirst.mockResolvedValue({ id: 'ac-1' });
    return accessToken;
  }

  const criar = (token: string, corpo: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(ROTA)
      .set('Authorization', `Bearer ${token}`)
      .send({ planoId: PLANO_ID, ...corpo });

  it('AC-009: plano INATIVO é 422 `PLANO_INATIVO`', async () => {
    const token = await comoAdmin();
    prisma.plano.findFirst.mockResolvedValue({
      id: PLANO_ID,
      nome: 'Mensal',
      valorCentavos: 30000,
      prazoMeses: 1,
      linkPagamentoUrl: null,
      ativo: false,
    });

    const res = await criar(token).expect(422);
    expect(bodyOf<{ code: string }>(res).code).toBe('PLANO_INATIVO');
  });

  it('AC-008: empresa SEM contrato publicado é 422 `CONTRATO_NAO_PUBLICADO`', async () => {
    const token = await comoAdmin();
    prisma.empresa.findUniqueOrThrow.mockResolvedValue({
      contratoVersaoVigente: null,
    });

    const res = await criar(token).expect(422);
    // Não dá para matricular contra um texto que não existe — e a mensagem
    // manda o gestor publicar, que é o que resolve.
    expect(bodyOf<{ code: string }>(res).code).toBe('CONTRATO_NAO_PUBLICADO');
  });

  it('AC-007: aluno que não aceitou o contrato é 422 `CONTRATO_NAO_ACEITO`', async () => {
    const token = await comoAdmin();
    prisma.aceite.findFirst.mockResolvedValue(null);

    const res = await criar(token).expect(422);
    // **É a recusa que evita o `500`.** Sem ela, a FK causal responderia
    // `23503` e o gestor leria "erro no servidor" sobre um aluno que só
    // precisa abrir o app.
    expect(bodyOf<{ code: string }>(res).code).toBe('CONTRATO_NAO_ACEITO');
    expect(prisma.matricula.create).not.toHaveBeenCalled();
  });

  it('AC-005/AC-006: sem `valorCentavos`, usa o de tabela — e congela os DOIS', async () => {
    const token = await comoAdmin();
    prisma.$queryRaw.mockResolvedValue([{ fim: new Date('2026-10-10') }]);
    prisma.matricula.create.mockResolvedValue({
      id: 'm-1',
      alunoId: ALUNO_ID,
      planoId: PLANO_ID,
      valorCentavos: 30000,
      valorDeTabelaCentavos: 30000,
      prazoMeses: 1,
      inicio: new Date('2026-09-10'),
      fim: new Date('2026-10-10'),
      contratoVersao: 3,
      plano: { nome: 'Mensal', linkPagamentoUrl: null },
    });

    await criar(token, { inicio: '2026-09-10' }).expect(201);

    const [args] = prisma.matricula.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data.valorCentavos).toBe(30000);
    expect(args.data.valorDeTabelaCentavos).toBe(30000);
    expect(args.data.contratoVersao).toBe(3);
  });

  it('**`valorCentavos: 0` é bolsa integral, não "ausente"**', async () => {
    const token = await comoAdmin();
    prisma.$queryRaw.mockResolvedValue([{ fim: new Date('2026-10-10') }]);
    prisma.matricula.create.mockResolvedValue({
      id: 'm-1',
      alunoId: ALUNO_ID,
      planoId: PLANO_ID,
      valorCentavos: 0,
      valorDeTabelaCentavos: 30000,
      prazoMeses: 1,
      inicio: new Date('2026-09-10'),
      fim: new Date('2026-10-10'),
      contratoVersao: 3,
      plano: { nome: 'Mensal', linkPagamentoUrl: null },
    });

    const res = await criar(token, { valorCentavos: 0 }).expect(201);

    const [args] = prisma.matricula.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    // `dto.valorCentavos || plano.valorCentavos` transformaria a bolsa em
    // preço cheio **em silêncio** — é por isso que o serviço compara contra
    // `undefined`, e é por isso que este caso existe.
    expect(args.data.valorCentavos).toBe(0);
    // E o desconto aparece calculado, sem coluna própria.
    expect(bodyOf<{ descontoCentavos: number }>(res).descontoCentavos).toBe(
      30000,
    );
  });

  it('AC-013: professor recebe 403 em `/me/matricula`', async () => {
    const usuario = await buildUsuarioAtivo({
      id: 'u-prof',
      email: 'prof@clube.local',
      role: 'professor',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    await request(app.getHttpServer())
      .get('/api/v1/me/matricula')
      .set('Authorization', `Bearer ${accessToken}`)
      // Professor não tem matrícula. Devolver `null` seria dizer "você não
      // tem plano" a quem nunca poderia ter — e a tela dele mostraria um
      // convite para contratar.
      .expect(403);
  });

  it('AC-011: aluno sem matrícula recebe `null`, e status 200', async () => {
    const usuario = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'ana@clube.local',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.matricula.findFirst.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get('/api/v1/me/matricula')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Não ter plano é um estado NORMAL — a tabela nasceu vazia. `404` faria a
    // tela tratar o normal como erro, que é o defeito que a carteira levou
    // para produção na SPEC-033.
    expect(res.body).toEqual({});
  });
});

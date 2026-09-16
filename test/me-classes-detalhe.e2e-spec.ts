import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-057/TASK-002 (card 5352) — **o aluno vê o que tem na turma dele.**
 *
 * > *"gostaria de ver o que tem na minha turma: professor, outros alunos,
 * > nível da turma"*
 *
 * ## Por que este arquivo é o principal desta task
 *
 * Esta rota **abre uma superfície de dado pessoal de terceiro**: o nome de
 * quem mais está na turma. Até aqui, a lista de alunos era direito só do
 * professor (SPEC-013/AC-008) e do gestor — e o DTO do gestor carrega
 * **e-mail** (`turma-response.dto.ts:110`), o que torna o reuso dele um
 * vazamento direto.
 *
 * O Israel autorizou o recorte por resposta literal (2026-09-16): **"Sim,
 * nome e nível"**. A INV-139 é o limite disso, e o limite é **só aplicação**
 * — não há constraint de banco que impeça um `include` a mais amanhã. Por
 * isso a prova aqui é o **conjunto EXATO de chaves**, inclusive dentro dos
 * objetos aninhados: procurar a ausência de um e-mail esperado deixaria
 * passar qualquer campo que ninguém pensou em procurar.
 */
const rota = (id: string) => `/api/v1/me/classes/${id}`;
const TURMA = '5f899c7b-9503-46b1-a402-f9578c737876';

describe('A turma do aluno (e2e) — SPEC-057/TASK-002', () => {
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
    prisma.aluno.findFirst.mockResolvedValue({ id: 'aluno-1' });
    return accessToken;
  }

  function turmaCrua() {
    return {
      id: TURMA,
      nome: 'Infantil A',
      status: 'ativa',
      capacidade: 6,
      quadra: { nome: 'Quadra 1' },
      nivel: { nome: 'Iniciante' },
      professor: { nome: 'Ana Coach' },
      encontros: [
        {
          diaSemana: 2,
          horaInicio: new Date('1970-01-01T18:00:00.000Z'),
          horaFim: new Date('1970-01-01T19:00:00.000Z'),
        },
      ],
      alunos: [
        {
          aluno: {
            id: 'aluno-1',
            usuario: { nome: 'Eu Mesmo' },
            nivel: { nome: 'Iniciante' },
          },
        },
        {
          aluno: {
            id: 'aluno-2',
            usuario: { nome: 'Colega Silva' },
            nivel: null,
          },
        },
      ],
    };
  }

  it('devolve professor, nível, encontros, quadra e colegas', async () => {
    const accessToken = await comoAluno();
    prisma.turma.findFirst.mockResolvedValue(turmaCrua());

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    const corpo = bodyOf<Record<string, unknown>>(resposta);
    expect(corpo.nome).toBe('Infantil A');
    expect(corpo.professorNome).toBe('Ana Coach');
    expect(corpo.nivelNome).toBe('Iniciante');
    expect(corpo.quadraNome).toBe('Quadra 1');
    expect(corpo.encontros).toEqual([
      { diaSemana: 2, horaInicio: '18:00', horaFim: '19:00' },
    ]);
  });

  /**
   * **A prova da INV-139.** Conjunto fechado, nos dois níveis. Procurar por
   * `email` seria fraco: o campo que vaza amanhã é o que ninguém listou.
   */
  it('o conjunto de chaves é EXATO — na raiz e em cada colega', async () => {
    const accessToken = await comoAluno();
    prisma.turma.findFirst.mockResolvedValue(turmaCrua());

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    const corpo = bodyOf<Record<string, unknown>>(resposta);
    expect(Object.keys(corpo).sort()).toEqual([
      'capacidade',
      'colegas',
      'encontros',
      'id',
      'nivelNome',
      'nome',
      'professorNome',
      'quadraNome',
      'status',
    ]);

    const colegas = corpo.colegas as Record<string, unknown>[];
    expect(colegas).toHaveLength(2);
    for (const colega of colegas) {
      // **Sem `id`**: o nome é o que a tela mostra, e um id é uma alça para
      // pedir outra coisa. Sem telefone, e-mail, pagamento ou vínculo.
      expect(Object.keys(colega).sort()).toEqual([
        'nivelNome',
        'nome',
        'souEu',
      ]);
    }
  });

  it('marca qual dos colegas é o próprio aluno, sem expor id', async () => {
    const accessToken = await comoAluno();
    prisma.turma.findFirst.mockResolvedValue(turmaCrua());

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    const colegas = bodyOf<{ colegas: { nome: string; souEu: boolean }[] }>(
      resposta,
    ).colegas;
    expect(colegas.find((c) => c.souEu)?.nome).toBe('Eu Mesmo');
    expect(colegas.find((c) => !c.souEu)?.nome).toBe('Colega Silva');
  });

  /**
   * **404, nunca 403.** O escopo é por matrícula, e vai no `WHERE` — não é
   * conferido depois de buscar. `403` confirmaria que a turma existe, e
   * quem não está nela não tem direito nem a essa confirmação.
   */
  it('turma em que ele não está matriculado responde 404', async () => {
    const accessToken = await comoAluno();
    prisma.turma.findFirst.mockResolvedValue(null);

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(404);
  });

  it('o escopo de matrícula e de empresa está no WHERE', async () => {
    const accessToken = await comoAluno();
    prisma.turma.findFirst.mockResolvedValue(turmaCrua());

    await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    const [args] = prisma.turma.findFirst.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where.id).toBe(TURMA);
    expect(args.where.companyId).toBeDefined();
    expect(args.where.alunos).toEqual({
      some: { alunoId: 'aluno-1' },
    });
  });

  it('professor não lê a rota do aluno', async () => {
    const professor = await buildUsuarioAtivo({
      id: 'u-prof',
      email: 'prof@empresa.demo',
      role: 'professor',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, professor);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    const resposta = await request(app.getHttpServer())
      .get(rota(TURMA))
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(403);
  });
});

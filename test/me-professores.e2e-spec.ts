import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-047/REQ-002 — `GET /me/professores`, **pela camada HTTP**.
 *
 * ## Por que este arquivo existe, tendo db-spec
 *
 * O db-spec já afere **quem** aparece e **por quanto**, sobre dados reais. O
 * que ele não alcança é o que só existe nesta camada: o que a resposta
 * **serializa**, e quem consegue chamar.
 *
 * E é aqui que mora o risco de verdade. **Esconder por projeção é correto e
 * silencioso**: no dia em que alguém trocar o `select` por um `findMany` sem
 * `select` — ou acrescentar `telefone` ao DTO "só para a tela mostrar" —, nada
 * quebra, e o telefone do professor aparece no app de todo aluno do clube.
 *
 * A AC-007 é uma **afirmação de ausência**, e afirmação de ausência sem teste
 * é opinião.
 */
const ROTA = '/api/v1/me/professores';

describe('Professores para o aluno (e2e) — SPEC-047/REQ-002', () => {
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

  /** A linha crua como o Prisma a devolveria, **com os campos de ficha juntos**. */
  function professorCru(extra: Record<string, unknown> = {}) {
    return {
      id: 'prof-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      nome: 'Ana Coach',
      precoAula: 150,
      usuarioId: null,
      fotoKey: null,
      usuario: null,
      ...extra,
    };
  }

  it('AC-004: devolve nome, foto e preço', async () => {
    const accessToken = await comoAluno();
    prisma.professor.findMany.mockResolvedValue([professorCru()]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // `toEqual` e não `toMatchObject`: **chave a mais é regressão de
    // contrato**, e este arquivo existe justamente para a chave a mais.
    expect(bodyOf(resposta)).toEqual([
      { id: 'prof-1', nome: 'Ana Coach', fotoUrl: null, precoAula: 150 },
    ]);
  });

  it('**AC-007: telefone, e-mail e `usuarioId` NÃO saem — nem se vierem do banco**', async () => {
    const accessToken = await comoAluno();
    // O banco devolvendo os campos de ficha é o cenário que importa: se a
    // proteção fosse só o `select`, um dia alguém o troca e isto passa a
    // vazar. O que tem de segurar é a **forma da resposta**.
    prisma.professor.findMany.mockResolvedValue([
      professorCru({
        telefone: '11999990000',
        email: 'ana@clube.demo',
        usuarioId: 'u-prof-1',
        usuario: { fotoKey: null },
      }),
    ]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // O tipo vai no GENÉRICO, não num `as` depois: é para isso que o
    // `bodyOf<T>` existe, e o `eslint --fix` remove o `as` redundante — o que
    // deixaria o acesso `unsafe` e o lint vermelho.
    const corpo = bodyOf<Record<string, unknown>[]>(resposta);
    expect(corpo).toHaveLength(1);
    expect(Object.keys(corpo[0]).sort()).toEqual([
      'fotoUrl',
      'id',
      'nome',
      'precoAula',
    ]);
    expect(corpo[0]).not.toHaveProperty('telefone');
    expect(corpo[0]).not.toHaveProperty('email');
    expect(corpo[0]).not.toHaveProperty('usuarioId');
  });

  it('e a CONSULTA também não pede telefone nem e-mail', async () => {
    const accessToken = await comoAluno();
    prisma.professor.findMany.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // As duas metades fazem falta: a de cima prova que **não sai**, esta prova
    // que **não é lido**. Campo que nunca sai do banco não vaza numa
    // serialização futura — a mesma decisão do `motivo` na SPEC-033/AC-013.
    const [args] = prisma.professor.findMany.mock.calls[0] as [
      { select: Record<string, unknown>; where: Record<string, unknown> },
    ];
    expect(args.select).not.toHaveProperty('telefone');
    expect(args.select).not.toHaveProperty('email');
    // AC-006 — e só professor ATIVO é lido.
    expect(args.where).toMatchObject({ status: 'ativo' });
  });

  it('a consulta é escopada pela empresa DO TOKEN', async () => {
    const accessToken = await comoAluno();
    prisma.professor.findMany.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const [args] = prisma.professor.findMany.mock.calls[0] as [
      { where: { companyId: string } },
    ];
    expect(args.where.companyId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('AC-005: professor sem preço não aparece, e o filtro é da rota', async () => {
    const accessToken = await comoAluno();
    prisma.professor.findMany.mockResolvedValue([
      professorCru(),
      professorCru({ id: 'prof-2', nome: 'Sem preço', precoAula: null }),
    ]);
    // Sem padrão do clube (o `findUnique` da config devolve `null` por padrão
    // neste mock), o segundo não tem preço resolvido.

    const corpo = bodyOf<{ id: string }[]>(
      await request(app.getHttpServer())
        .get(ROTA)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200),
    );

    expect(corpo.map((p) => p.id)).toEqual(['prof-1']);
  });

  it('sem preço próprio, o PADRÃO do clube o traz de volta', async () => {
    const accessToken = await comoAluno();
    prisma.professor.findMany.mockResolvedValue([
      professorCru({ id: 'prof-2', nome: 'Sem preço', precoAula: null }),
    ]);
    prisma.configOperacaoEmpresa.findUnique.mockResolvedValue({
      precoAulaPadrao: 90,
    });

    const corpo = bodyOf<{ precoAula: number }[]>(
      await request(app.getHttpServer())
        .get(ROTA)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200),
    );

    expect(corpo).toHaveLength(1);
    expect(corpo[0].precoAula).toBe(90);
  });

  it('**o gestor NÃO usa esta rota** — ele tem `/teachers`, com a ficha inteira', async () => {
    const admin = await buildUsuarioAtivo();
    const { accessToken } = await loginAndGetTokens(app, prisma, admin);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    // `@Roles('aluno')` e não o prefixo `/me/`: o prefixo é convenção, o
    // decorator é o portão. E a rota nem chega a consultar.
    expect(prisma.professor.findMany).not.toHaveBeenCalled();
  });

  it('sem token, 401', async () => {
    await request(app.getHttpServer()).get(ROTA).expect(401);
  });
});

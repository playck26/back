/**
 * SPEC-082/REQ-001 — **a trava do aluno** (AC-012, AC-013).
 *
 * Com a do clube compartilhada, era a trava EXCLUSIVA do clube que punha em
 * fila, sem dizer, duas matrículas do mesmo aluno — e o limite de turmas
 * (SPEC-023) contava com isso. A trava do aluno devolve essa fila, e só ela.
 *
 * - **AC-012** — com a trava de teste do **aluno** segura, cada leitor, para
 *   aquele aluno, **espera** (visto em `pg_stat_activity`).
 * - **AC-013** — o limite de turmas não fura, com resultado determinístico:
 *   (a) o teste comita antes de 2 s → `LIMITE_DE_TURMAS`; (b) segura mais de
 *   2 s → `MATRICULA_EM_ANDAMENTO` com a I6; (c) dois `entrar` simultâneos do
 *   mesmo aluno → 1 × 200 e 1 × 409.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  type AlunoDaFixtura,
  BASE,
  type Clube,
  I6,
  PRAZO_MS,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  dormir,
  limparClube,
  linhaChamada,
  montarClube,
  resposta,
  rotas,
  segurar,
  travaDoAluno,
  turmasDoAluno,
  urlDoCaminho,
  vistoEsperando,
} from './spec-082-fixture';

jest.setTimeout(300_000);
exigirBancoLocal();

const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await limparClube(db, clube);
  clube = null;
  await desconectarTodos();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('SPEC-082/AC-012 — cada leitor toma a trava do aluno', () => {
  const leitores: [
    string,
    (
      r: ReturnType<typeof rotas>,
      c: Clube,
      a: AlunoDaFixtura,
      turma: string,
      linha: string,
    ) => Promise<unknown>,
  ][] = [
    ['entrar', (r, c, a, t) => r.entrar(c, a, t)],
    ['allocateStudent', (r, c, a, t) => r.alocar(c, a, t)],
    ['confirmar (fila de turma)', (r, c, a, _t, l) => r.confirmar(c, a, l)],
  ];

  it.each(leitores)(
    '%s: com a trava do aluno segura, espera por ela',
    async (nome, chamar) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube);
      const a = await criarAluno(db, clube);
      const linha = await linhaChamada(db, clube, a.alunoId, turma);
      const app = `spec082-aluno-${nome.replace(/\W/g, '').toLowerCase()}`;

      const soltar = await segurar(db, travaDoAluno(a.alunoId));
      let caminho: Promise<unknown> = Promise.resolve();
      try {
        caminho = resposta(
          chamar(rotas(cliente(urlDoCaminho(app))), clube, a, turma, linha),
        );
        await vistoEsperando(db, app, 'advisory', PRAZO_MS);
      } finally {
        await soltar();
      }
      // Solta a tempo: a matrícula segue e grava.
      expect(await caminho).toMatchObject({ status: 200 });
      expect(await turmasDoAluno(db, a.alunoId)).toBe(1);
    },
  );
});

describe('SPEC-082/AC-013 — o limite de turmas não fura', () => {
  async function cenario() {
    clube = await montarClube(db, { limite: 1 });
    const turmaA = await criarTurma(db, clube);
    const turmaB = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    return { c: clube, turmaA, turmaB, a };
  }

  /**
   * A transação de teste segura a trava do aluno E matricula o aluno na turma
   * A; o `entrar` na turma B espera; o teste comita depois de `seguraMs`.
   */
  async function correr(seguraMs: number) {
    const { c, turmaA, turmaB, a } = await cenario();
    const app = `spec082-limite-${seguraMs}`;
    const soltar = await segurar(db, async (t) => {
      await travaDoAluno(a.alunoId)(t);
      await t.$executeRawUnsafe(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaA}','${a.alunoId}',now())`,
      );
    });
    let caminho: Promise<Awaited<ReturnType<typeof resposta>>> =
      Promise.resolve({ status: 0 });
    try {
      caminho = resposta(
        rotas(cliente(urlDoCaminho(app))).entrar(c, a, turmaB),
      );
      await vistoEsperando(db, app, 'advisory', PRAZO_MS);
      await dormir(seguraMs);
    } finally {
      await soltar();
    }
    return { r: await caminho, a };
  }

  it('(a) o teste comita ANTES de 2 s → 409 LIMITE_DE_TURMAS, e o aluno termina em uma turma', async () => {
    const { r, a } = await correr(300);
    expect(r).toMatchObject({ status: 409, code: 'LIMITE_DE_TURMAS' });
    expect(await turmasDoAluno(db, a.alunoId)).toBe(1);
  });

  it('(b) o teste segura MAIS de 2 s → 409 MATRICULA_EM_ANDAMENTO com a I6, e o aluno termina em uma turma', async () => {
    const { r, a } = await correr(PRAZO_MS + 500);
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(await turmasDoAluno(db, a.alunoId)).toBe(1);
  });

  it('(c) dois entrar simultâneos do mesmo aluno em duas turmas → exatamente 1 × 200 e 1 × 409 LIMITE_DE_TURMAS', async () => {
    const { c, turmaA, turmaB, a } = await cenario();
    // Duas conexões independentes: com uma só, serializariam por acidente.
    const [r1, r2] = await Promise.all([
      resposta(rotas(cliente(BASE)).entrar(c, a, turmaA)),
      resposta(rotas(cliente(BASE)).entrar(c, a, turmaB)),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)).toMatchObject({
      code: 'LIMITE_DE_TURMAS',
    });
    expect(await turmasDoAluno(db, a.alunoId)).toBe(1);
  });
});

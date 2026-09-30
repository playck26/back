/**
 * SPEC-082/AC-018 — **o corpo HTTP não muda** (achado 082-V4-02).
 *
 * O `tx.turmaAluno.create` virou SQL cru (D2b), e o retorno dele É o corpo
 * HTTP de `entrar` e de `allocateStudent`. Um `RETURNING` sem alias devolveria
 * `turma_id` no lugar de `turmaId` — e um teste que só conferisse a linha no
 * banco passaria. Por isso a comparação é do **objeto devolvido**, campo a
 * campo e por tipo, contra o que o `turmaAluno.create` de hoje devolve.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  BASE,
  type Clube,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  limparClube,
  montarClube,
  rotas,
} from './spec-082-fixture';

jest.setTimeout(120_000);
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

/** O "formato" de um objeto: cada chave com o tipo do valor. */
function formato(o: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(o as Record<string, unknown>)
      .map(([k, v]): [string, string] => [
        k,
        v instanceof Date ? 'Date' : typeof v,
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe('SPEC-082/AC-018 — o retorno do INSERT com prazo tem o formato do create de hoje', () => {
  it.each(['entrar', 'allocateStudent'] as const)(
    '%s devolve id, turmaId, alunoId e createdAt (Date) — os mesmos campos e tipos do tx.turmaAluno.create',
    async (caminho) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube);
      const outra = await criarTurma(db, clube);
      const a = await criarAluno(db, clube);
      const b = await criarAluno(db, clube);

      // O de hoje: a API de modelo, na mesma tabela.
      const deHoje = await db.turmaAluno.create({
        data: { turmaId: outra, alunoId: b.alunoId },
      });

      const r = rotas(cliente(BASE));
      const devolvido = (
        caminho === 'entrar'
          ? await r.entrar(clube, a, turma)
          : await r.alocar(clube, a, turma)
      ) as Record<string, unknown>;

      expect(formato(devolvido)).toEqual(formato(deHoje));
      expect(formato(devolvido)).toEqual({
        alunoId: 'string',
        createdAt: 'Date',
        id: 'string',
        turmaId: 'string',
      });

      // E os valores são os da linha gravada.
      const linha = await db.turmaAluno.findUniqueOrThrow({
        where: { id: devolvido.id as string },
      });
      expect(devolvido).toEqual(linha);
      expect(devolvido).toMatchObject({ turmaId: turma, alunoId: a.alunoId });
    },
  );
});

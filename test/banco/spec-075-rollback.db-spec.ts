/**
 * SPEC-075 — **a compensatória das FKs de nível é EXECUTADA, não lida.**
 *
 * A spec dizia "a migration é reversível", e a validação da implementação
 * (achado A-06) mostrou que era receita: reverter o merge não troca as FKs de
 * volta, e não havia arquivo pronto. O arquivo agora existe
 * (`prisma/rollback/075-fks-de-nivel-simples.sql`), e "é válido" não se
 * confere lendo — a lição da SPEC-069, que achou um `DROP ... ON tabela_errada`
 * que passava em toda conferência de forma.
 *
 * **Como se prova sem estragar o banco:** DDL do Postgres é transacional. O
 * arquivo roda inteiro dentro de uma transação, o estado de `pg_constraint` é
 * conferido lá dentro, e a transação é desfeita. O banco sai como entrou — e
 * isso também é conferido.
 */
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';

jest.setTimeout(120_000);
exigirBancoLocal();

const db = new PrismaClient();
const RAIZ = join(__dirname, '..', '..');
const ARQUIVO = join(
  RAIZ,
  'prisma',
  'rollback',
  '075-fks-de-nivel-simples.sql',
);

/** As definições de ANTES da SPEC-075, como o Postgres as descreve. */
const SIMPLES =
  'FOREIGN KEY (nivel_id) REFERENCES niveis(id) ON UPDATE CASCADE ON DELETE SET NULL';

type Fk = { tabela: string; nome: string; def: string };

async function fksDeNivel(
  cliente: Pick<PrismaClient, '$queryRaw'>,
): Promise<Fk[]> {
  return cliente.$queryRaw<Fk[]>`
    SELECT c.conrelid::regclass::text AS tabela, c.conname AS nome,
           pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = 'niveis'::regclass
       AND c.conrelid::regclass::text IN ('alunos', 'turmas', 'convites_aluno')
     ORDER BY 1`;
}

async function temChaveComposta(
  cliente: Pick<PrismaClient, '$queryRaw'>,
): Promise<boolean> {
  const r = await cliente.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conname = 'niveis_company_id_id_key'`;
  return r[0].n === 1;
}

/** As instruções do arquivo, sem os comentários. Nenhuma tem `;` por dentro. */
function instrucoes(): string[] {
  return readFileSync(ARQUIVO, 'utf8')
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

class Desfazer extends Error {}

afterAll(async () => {
  await db.$disconnect();
});

describe('a compensatória das FKs de nível (SPEC-075, achado A-06)', () => {
  it('mora em prisma/rollback, e NENHUMA migration a contém — migration pendente é aplicada', () => {
    const conteudo = readFileSync(ARQUIVO, 'utf8');
    const migrations = join(RAIZ, 'prisma', 'migrations');
    for (const dir of readdirSync(migrations, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const sql = readFileSync(
        join(migrations, dir.name, 'migration.sql'),
        'utf8',
      );
      expect(sql).not.toBe(conteudo);
      expect(sql).not.toContain('DROP CONSTRAINT "alunos_nivel_fkey"');
    }
    expect(instrucoes()).toHaveLength(7);
  });

  it('o ponto de partida é o da SPEC-075: as três FKs compostas e a chave delas', async () => {
    const antes = await fksDeNivel(db);
    expect(antes.map((f) => f.nome)).toEqual([
      'alunos_nivel_fkey',
      'convites_nivel_fkey',
      'turmas_nivel_fkey',
    ]);
    for (const f of antes) {
      expect(f.def).toContain('FOREIGN KEY (company_id, nivel_id)');
    }
    expect(await temChaveComposta(db)).toBe(true);
  });

  it('**aplicada, devolve exatamente as FKs de antes — e a transação desfaz tudo**', async () => {
    let dentro: Fk[] = [];
    let chaveDentro = true;

    await expect(
      db.$transaction(async (tx) => {
        for (const sql of instrucoes()) await tx.$executeRawUnsafe(sql);
        dentro = await fksDeNivel(tx);
        chaveDentro = await temChaveComposta(tx);
        throw new Desfazer();
      }),
    ).rejects.toBeInstanceOf(Desfazer);

    // Dentro da transação: os nomes e a definição das migrations originais.
    expect(dentro).toEqual([
      { tabela: 'alunos', nome: 'alunos_nivel_id_fkey', def: SIMPLES },
      {
        tabela: 'convites_aluno',
        nome: 'convites_aluno_nivel_id_fkey',
        def: SIMPLES,
      },
      { tabela: 'turmas', nome: 'turmas_nivel_id_fkey', def: SIMPLES },
    ]);
    expect(chaveDentro).toBe(false);

    // E o banco saiu como entrou.
    const depois = await fksDeNivel(db);
    expect(depois.map((f) => f.nome)).toEqual([
      'alunos_nivel_fkey',
      'convites_nivel_fkey',
      'turmas_nivel_fkey',
    ]);
    expect(await temChaveComposta(db)).toBe(true);
  });
});

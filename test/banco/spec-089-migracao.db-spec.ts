/**
 * SPEC-089/AC-001 (IMPL-089-02) — **a empresa que já existia antes da
 * migration**, pela sequência literal: um banco descartável migrado até a
 * migration ANTERIOR à 089, uma empresa inserida nele, e só então a migration
 * da 089. A coluna tem de sair `true` nessa empresa (S1: um `DEFAULT false` no
 * arquivo da migration a deixa `false`).
 *
 * O `prisma migrate deploy` aplica todas as migrations de uma pasta. Por isso
 * o teste monta, num diretório temporário, uma cópia do `schema.prisma` com a
 * pasta de migrations **sem** a da 089, aplica, insere a empresa, copia a
 * migration da 089 para lá e aplica de novo — o mesmo comando que o deploy
 * roda em produção, nas duas vezes.
 *
 * O banco descartável nasce e morre aqui (`CREATE`/`DROP DATABASE` pelo banco
 * `postgres` do mesmo servidor): a suíte não toca o banco de quem a roda.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';

jest.setTimeout(600_000);
exigirBancoLocal();

const MIGRATION_089 = '20261025120000_spec089_nivel_restringe_acesso';
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const RAIZ_PRISMA = join(__dirname, '../../prisma');

/** A URL de outro banco no mesmo servidor do `DATABASE_URL`. */
function urlDoBanco(nome: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${nome}`;
  return url.toString();
}

function deploy(schema: string, url: string): void {
  execFileSync(
    process.execPath,
    [PRISMA_CLI, 'migrate', 'deploy', '--schema', schema],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
  );
}

const nome = `s089_migracao_${process.pid}`;
const admin = new PrismaClient({
  datasources: { db: { url: urlDoBanco('postgres') } },
});
let dir = '';

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`,
  );
  await admin.$executeRawUnsafe(`CREATE DATABASE "${nome}"`);
  dir = mkdtempSync(join(tmpdir(), 's089-migracao-'));
});

afterAll(async () => {
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`,
  );
  await admin.$disconnect();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('AC-001 — empresa inserida com o banco na migration anterior sai `true` depois da migration da 089', async () => {
  const url = urlDoBanco(nome);
  const schema = join(dir, 'schema.prisma');
  cpSync(join(RAIZ_PRISMA, 'schema.prisma'), schema);
  cpSync(join(RAIZ_PRISMA, 'migrations'), join(dir, 'migrations'), {
    recursive: true,
    filter: (origem) => !origem.includes(MIGRATION_089),
  });
  // A premissa, afirmada: a cópia não tem a 089, e tem todas as outras.
  const copiadas = readdirSync(join(dir, 'migrations'));
  const todas = readdirSync(join(RAIZ_PRISMA, 'migrations'));
  expect(copiadas).not.toContain(MIGRATION_089);
  expect(copiadas.length).toBe(todas.length - 1);

  deploy(schema, url);

  const banco = new PrismaClient({ datasources: { db: { url } } });
  try {
    const antes = await banco.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_name = 'empresas' AND column_name = 'nivel_restringe_acesso'`,
    );
    expect(Number(antes[0].n)).toBe(0);

    await banco.$executeRawUnsafe(
      `INSERT INTO empresas (id,nome,slug,updated_at)
       VALUES ('08900000-0000-4000-8000-0000000000aa','Antiga','antiga-089',now())`,
    );

    cpSync(
      join(RAIZ_PRISMA, 'migrations', MIGRATION_089),
      join(dir, 'migrations', MIGRATION_089),
      { recursive: true },
    );
    deploy(schema, url);

    const [linha] = await banco.$queryRawUnsafe<{ v: boolean }[]>(
      `SELECT nivel_restringe_acesso AS v FROM empresas
        WHERE id = '08900000-0000-4000-8000-0000000000aa'`,
    );
    expect(linha.v).toBe(true);
  } finally {
    await banco.$disconnect();
  }
});

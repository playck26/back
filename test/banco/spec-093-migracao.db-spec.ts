/**
 * SPEC-093/AC-001 — **a migration só troca o `DEFAULT`**, pela sequência
 * literal: um banco descartável migrado até a migration ANTERIOR à 093, dois
 * clubes nele (um com a chave ligada, outro desligada), e só então a 093.
 *
 * Os dois clubes têm de sair como entraram (um `UPDATE` na migration
 * deixaria o ligado `false`), e o clube que nasce depois dela sai `false` (um
 * `DEFAULT` esquecido o deixaria `true`).
 *
 * Mesmo desenho da `spec-089-migracao.db-spec.ts`: o `prisma migrate deploy`
 * de verdade, duas vezes, num banco que nasce e morre aqui.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';

jest.setTimeout(600_000);
exigirBancoLocal();

const MIGRATION_093 = '20261030120000_spec093_clube_novo_liberado';
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const RAIZ_PRISMA = join(__dirname, '../../prisma');

const LIGADO = '09300000-0000-4000-8000-0000000000a1';
const DESLIGADO = '09300000-0000-4000-8000-0000000000a2';
const NOVO = '09300000-0000-4000-8000-0000000000a3';

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

const nome = `s093_migracao_${process.pid}`;
const admin = new PrismaClient({
  datasources: { db: { url: urlDoBanco('postgres') } },
});
let dir = '';

beforeAll(async () => {
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`,
  );
  await admin.$executeRawUnsafe(`CREATE DATABASE "${nome}"`);
  dir = mkdtempSync(join(tmpdir(), 's093-migracao-'));
});

afterAll(async () => {
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`,
  );
  await admin.$disconnect();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('AC-001 — os clubes que existiam ficam como estavam; o que nasce depois sai `false`', async () => {
  const url = urlDoBanco(nome);
  const schema = join(dir, 'schema.prisma');
  cpSync(join(RAIZ_PRISMA, 'schema.prisma'), schema);
  cpSync(join(RAIZ_PRISMA, 'migrations'), join(dir, 'migrations'), {
    recursive: true,
    filter: (origem) => !origem.includes(MIGRATION_093),
  });
  // A premissa, afirmada: a cópia não tem a 093, e tem todas as outras.
  const copiadas = readdirSync(join(dir, 'migrations'));
  const todas = readdirSync(join(RAIZ_PRISMA, 'migrations'));
  expect(todas).toContain(MIGRATION_093);
  expect(copiadas).not.toContain(MIGRATION_093);
  expect(copiadas.length).toBe(todas.length - 1);

  deploy(schema, url);

  const banco = new PrismaClient({ datasources: { db: { url } } });
  const ler = async () =>
    banco.$queryRawUnsafe<{ id: string; v: boolean }[]>(
      `SELECT id::text AS id, nivel_restringe_acesso AS v FROM empresas
        WHERE id IN ('${LIGADO}','${DESLIGADO}','${NOVO}') ORDER BY id`,
    );
  try {
    // Antes da 093, o padrão ainda é `true` (SPEC-089): o LIGADO nasce pelo
    // padrão, e o DESLIGADO como o `UPDATE` do Israel o deixou.
    await banco.$executeRawUnsafe(
      `INSERT INTO empresas (id,nome,slug,updated_at)
       VALUES ('${LIGADO}','Ligado','ligado-093',now())`,
    );
    await banco.$executeRawUnsafe(
      `INSERT INTO empresas (id,nome,slug,updated_at,nivel_restringe_acesso)
       VALUES ('${DESLIGADO}','Desligado','desligado-093',now(),false)`,
    );
    expect(await ler()).toEqual([
      { id: LIGADO, v: true },
      { id: DESLIGADO, v: false },
    ]);

    cpSync(
      join(RAIZ_PRISMA, 'migrations', MIGRATION_093),
      join(dir, 'migrations', MIGRATION_093),
      { recursive: true },
    );
    deploy(schema, url);

    await banco.$executeRawUnsafe(
      `INSERT INTO empresas (id,nome,slug,updated_at)
       VALUES ('${NOVO}','Novo','novo-093',now())`,
    );
    expect(await ler()).toEqual([
      { id: LIGADO, v: true },
      { id: DESLIGADO, v: false },
      { id: NOVO, v: false },
    ]);
  } finally {
    await banco.$disconnect();
  }
});

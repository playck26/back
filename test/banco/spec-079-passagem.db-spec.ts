/**
 * SPEC-079/D2 — **a migração A é EXECUTADA, não lida** (AC-008, AC-009,
 * AC-010, AC-018).
 *
 * O arquivo de produção (`prisma/migrations/…_spec079_niveis_e_primeiro_nivel`)
 * roda inteiro dentro de uma transação, o resultado é conferido lá dentro, e a
 * transação é desfeita (o molde do `spec-075-rollback`). Desfazer importa: a
 * migração alcança TODAS as empresas do banco, e as das outras suítes não
 * podem sair daqui com níveis que não tinham.
 *
 * Por alcançar todas, as conferências são globais — "toda empresa sem nível",
 * "toda turma sem nível" — e as fixturas daqui só garantem que o universo não
 * é vazio, e que o desempate da INV-075c é exercitado.
 *
 * A AC-018 prova a trava por **espera real**: uma conexão segura
 * `travarNivelDaEmpresa` de uma empresa com turma sem nível, a migração para
 * nela, e a barreira vê isso em `pg_blocking_pids` — ordem forçada por lock, e
 * não por `sleep` (a lição do FIT-020).
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
import {
  NIVEIS_PADRAO,
  travarNivelDaEmpresa,
} from '../../src/people/nivel-efetivo';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(180_000);
exigirBancoLocal();

const db = new PrismaClient();
/** UMA conexão: o `pg_backend_pid()` lido fora da transação é o dela. */
const migrador = new PrismaClient({
  datasourceUrl: `${process.env.DATABASE_URL}${process.env.DATABASE_URL?.includes('?') ? '&' : '?'}connection_limit=1`,
});
const observador = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const PASTA = join(__dirname, '..', '..', 'prisma', 'migrations');
const NOME = readdirSync(PASTA).find((p) =>
  p.endsWith('_spec079_niveis_e_primeiro_nivel'),
);
const SQL = readFileSync(
  join(PASTA, NOME ?? 'ausente', 'migration.sql'),
  'utf8',
);

const base = 'f0790001-0000-4000-8000-0000000000';
/** Sem nível nenhum, com duas turmas sem nível. */
const E_SEM = `${base}01`;
/** Com níveis — empate de `ordem` que só o `created_at` desfaz —, uma turma
 *  sem nível e uma com um nível que NÃO é o primeiro. */
const E_COM = `${base}02`;
const NV_ULTIMO = `${base}21`;
const NV_EMPATE_NOVO = `${base}22`;
const NV_EMPATE_VELHO = `${base}23`;
const T_SEM_1 = `${base}31`;
const T_SEM_2 = `${base}32`;
const T_COM_SEM = `${base}33`;
const T_COM_COM = `${base}34`;

class Desfazer extends Error {}

async function montar(): Promise<void> {
  for (const emp of [E_SEM, E_COM]) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-079 ${emp.slice(-2)}','spec-079-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES (gen_random_uuid(),'${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80,'ativa')`,
    );
  }
  for (const [id, nome, ordem, criado] of [
    [NV_ULTIMO, 'Último', 0, '2026-01-01'],
    [NV_EMPATE_NOVO, 'Empate novo', -1, '2026-03-01'],
    [NV_EMPATE_VELHO, 'Empate velho', -1, '2026-02-01'],
  ] as const) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem,created_at) VALUES ('${id}','${E_COM}','${nome}',${ordem},'${criado}')`,
    );
  }
  for (const [id, emp, nivel] of [
    [T_SEM_1, E_SEM, null],
    [T_SEM_2, E_SEM, null],
    [T_COM_SEM, E_COM, null],
    [T_COM_COM, E_COM, NV_ULTIMO],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${emp}','T ${id.slice(-2)}',(SELECT id FROM quadras WHERE company_id='${emp}' LIMIT 1),4,'ativa',${nivel ? `'${nivel}'` : 'NULL'})`,
    );
  }
}

type Cliente = Pick<PrismaClient, '$queryRawUnsafe'>;

async function linhas<T>(c: Cliente, sql: string): Promise<T[]> {
  return c.$queryRawUnsafe<T[]>(sql);
}

/** Impressão digital de um conjunto de linhas: contagem e md5 do texto delas. */
async function digital(c: Cliente, tabela: string, where: string) {
  const [r] = await linhas<{ n: number; md5: string | null }>(
    c,
    `SELECT count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x.id)) AS md5
       FROM ${tabela} x WHERE ${where}`,
  );
  return r;
}

/** Roda a migração num cliente, confere lá dentro, e DESFAZ. */
async function rodarEDesfazer(
  cliente: PrismaClient,
  conferir: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await cliente
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(SQL);
        await conferir(tx);
        throw new Desfazer();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Desfazer)) throw e;
    });
}

beforeAll(async () => {
  for (const emp of [E_SEM, E_COM]) await limparEmpresa(db, emp);
  await montar();
});

afterAll(async () => {
  for (const emp of [E_SEM, E_COM]) await limparEmpresa(db, emp);
  await Promise.all([
    db.$disconnect(),
    migrador.$disconnect(),
    observador.$disconnect(),
  ]);
});

describe('SPEC-079 — a migração A existe, e é a de produção', () => {
  it('há exatamente uma pasta `_spec079_niveis_e_primeiro_nivel`', () => {
    expect(
      readdirSync(PASTA).filter((p) =>
        p.endsWith('_spec079_niveis_e_primeiro_nivel'),
      ),
    ).toHaveLength(1);
  });
});

describe('SPEC-079/AC-008 — os três níveis padrão, e só às empresas sem nível', () => {
  it('os nomes e as ordens do SQL são os de `NIVEIS_PADRAO`', () => {
    const valores =
      /VALUES\s*((?:\('[^']*',\s*-?\d+\)\s*,?\s*)+)\)\s*AS padrao/.exec(SQL);
    expect(valores).not.toBeNull();
    const tuplas = [...valores![1].matchAll(/\('([^']*)',\s*(-?\d+)\)/g)].map(
      (m) => ({ nome: m[1], ordem: Number(m[2]) }),
    );
    expect(tuplas).toEqual(NIVEIS_PADRAO);
  });

  it('toda empresa sem nível ganha os três; as que tinham não ganham nada', async () => {
    const semNivel = (
      await linhas<{ id: string }>(
        db,
        `SELECT id FROM empresas e WHERE NOT EXISTS (SELECT 1 FROM niveis n WHERE n.company_id = e.id)`,
      )
    ).map((r) => r.id);
    expect(semNivel).toContain(E_SEM);
    const antes = await digital(db, 'niveis', 'true');

    await rodarEDesfazer(db, async (tx) => {
      for (const emp of semNivel) {
        const nv = await linhas<{ nome: string; ordem: number }>(
          tx,
          `SELECT nome, ordem FROM niveis WHERE company_id = '${emp}' ORDER BY ordem`,
        );
        expect(nv).toEqual(NIVEIS_PADRAO);
      }
      const lista = semNivel.map((e) => `'${e}'`).join(',');
      // Os níveis das empresas que já tinham: os mesmos, byte a byte.
      expect(
        await digital(tx, 'niveis', `company_id NOT IN (${lista})`),
      ).toEqual(antes);
      const [{ n }] = await linhas<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM empresas e WHERE NOT EXISTS (SELECT 1 FROM niveis x WHERE x.company_id = e.id)`,
      );
      expect(n).toBe(0);
    });
  });
});

describe('SPEC-079/AC-009 e AC-010 — o primeiro nível para toda turma sem nível, e nada mais', () => {
  it('cada turma sem nível recebe o primeiro da SUA empresa (INV-075c), e as outras não mudam', async () => {
    const semNivel = await linhas<{ id: string; company_id: string }>(
      db,
      `SELECT id, company_id FROM turmas WHERE nivel_id IS NULL ORDER BY id`,
    );
    expect(semNivel.map((t) => t.id)).toEqual(
      expect.arrayContaining([T_SEM_1, T_SEM_2, T_COM_SEM]),
    );
    const comNivelAntes = await digital(db, 'turmas', 'nivel_id IS NOT NULL');

    await rodarEDesfazer(db, async (tx) => {
      // As fixturas, pelo nome — independente da consulta da migração.
      const nivelDe = async (turma: string) =>
        (
          await linhas<{ nivel_id: string }>(
            tx,
            `SELECT nivel_id FROM turmas WHERE id = '${turma}'`,
          )
        )[0].nivel_id;
      const iniciante = (
        await linhas<{ id: string }>(
          tx,
          `SELECT id FROM niveis WHERE company_id = '${E_SEM}' AND nome = 'Iniciante'`,
        )
      )[0].id;
      expect(await nivelDe(T_SEM_1)).toBe(iniciante);
      expect(await nivelDe(T_SEM_2)).toBe(iniciante);
      // Empate de `ordem`: decide o `created_at` — o mais velho.
      expect(await nivelDe(T_COM_SEM)).toBe(NV_EMPATE_VELHO);
      // A que tinha nível — e não o primeiro — fica com ele.
      expect(await nivelDe(T_COM_COM)).toBe(NV_ULTIMO);

      // Todas as outras turmas sem nível: o primeiro nível da empresa DELA.
      for (const t of semNivel) {
        const [r] = await linhas<{ nivel_id: string; primeiro: string }>(
          tx,
          `SELECT t.nivel_id,
                  (SELECT n.id FROM niveis n WHERE n.company_id = t.company_id
                    ORDER BY n.ordem, n.created_at, n.id LIMIT 1) AS primeiro
             FROM turmas t WHERE t.id = '${t.id}'`,
        );
        expect(r.nivel_id).toBe(r.primeiro);
      }
      const [{ n }] = await linhas<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM turmas WHERE nivel_id IS NULL`,
      );
      expect(n).toBe(0);
      // AC-010: as turmas que já tinham nível, as mesmas, byte a byte.
      const ids = semNivel.map((t) => `'${t.id}'`).join(',');
      expect(
        await digital(
          tx,
          'turmas',
          `nivel_id IS NOT NULL AND id NOT IN (${ids})`,
        ),
      ).toEqual(comNivelAntes);
    });
  });

  it('idempotente: rodada de novo, não escreve nada', async () => {
    await rodarEDesfazer(db, async (tx) => {
      const niveis = await digital(tx, 'niveis', 'true');
      const turmas = await digital(tx, 'turmas', 'true');
      // O `$executeRawUnsafe` de um `DO` devolve 0 sempre: quem prova que
      // nada foi escrito são as impressões digitais.
      await tx.$executeRawUnsafe(SQL);
      expect(await digital(tx, 'niveis', 'true')).toEqual(niveis);
      expect(await digital(tx, 'turmas', 'true')).toEqual(turmas);
    });
  });
});

describe('SPEC-079/AC-018 — a migração toma a trava de nível da empresa', () => {
  /** A expressão da chave, tirada DO ARQUIVO — não uma cópia dela. */
  const expressao = /PERFORM pg_advisory_xact_lock\(\s*([\s\S]+?)\s*\);/.exec(
    SQL,
  )?.[1];

  it('a chave calculada pelo SQL da migração é a do `travarNivelDaEmpresa`', async () => {
    expect(expressao).toContain('empresa.id');
    for (const id of [
      '00000000-0000-4000-8000-000000000001',
      'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a',
      E_COM,
    ]) {
      const [r] = await linhas<{ chave: bigint }>(
        db,
        `SELECT ${expressao!.replace(/empresa\.id/g, `'${id}'::uuid`)} AS chave`,
      );
      expect(r.chave).toBe(ChaveDeLock.deTexto(`nivel-da-empresa:${id}`));
    }
  });

  it('com a trava da empresa segura por outra conexão, a migração ESPERA, e conclui quando ela solta', async () => {
    let soltar!: () => void;
    const solta = new Promise<void>((r) => (soltar = r));
    let segurando!: () => void;
    const segura = new Promise<void>((r) => (segurando = r));

    let pidDono = 0;
    const dono = db.$transaction(
      async (tx) => {
        await travarNivelDaEmpresa(tx, E_SEM);
        pidDono = (
          await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        segurando();
        await solta;
      },
      { timeout: 120_000 },
    );
    await segura;
    const [{ pid: pidMigrador }] = await migrador.$queryRaw<{ pid: number }[]>`
      SELECT pg_backend_pid() AS pid`;

    let concluiu = false;
    const migracao = rodarEDesfazer(migrador, async (tx) => {
      concluiu = true;
      const [r] = await linhas<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM turmas WHERE company_id = '${E_SEM}' AND nivel_id IS NULL`,
      );
      expect(r.n).toBe(0);
    });

    // A barreira: a conexão da migração parada numa trava CONSULTIVA, e
    // bloqueada por QUEM segura a da empresa — amarrada pelos dois pids, e não
    // pelo texto da consulta (o `pg_stat_activity.query` corta em 1024 bytes,
    // e o cabeçalho da migração passa disso).
    const esperando = async () => {
      const [r] = await observador.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity a
          WHERE a.pid = $1
            AND a.wait_event_type = 'Lock'
            AND a.wait_event = 'advisory'
            AND $2 = ANY (pg_blocking_pids(a.pid))`,
        pidMigrador,
        pidDono,
      );
      return r.n > 0;
    };
    const limite = Date.now() + 20_000;
    let viu = false;
    while (Date.now() < limite) {
      if (await esperando()) {
        viu = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(viu).toBe(true);
    expect(concluiu).toBe(false);
    soltar();
    await dono;
    await migracao;
    expect(concluiu).toBe(true);
  });
});

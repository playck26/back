/**
 * SPEC-079/D2 — **as duas migrações de passagem são EXECUTADAS, não lidas**
 * (AC-001, AC-008, AC-009, AC-010, AC-018).
 *
 * Os arquivos de produção (`…_spec079_niveis_e_primeiro_nivel`, a A;
 * `…_spec079_turma_nivel_not_null`, a B) rodam inteiros dentro de uma
 * transação, o resultado é conferido lá dentro, e a transação é desfeita (o
 * molde do `spec-075-rollback`). Desfazer importa: as migrações alcançam TODAS
 * as empresas do banco, e as das outras suítes não podem sair daqui mudadas.
 *
 * **Desde a migração B o banco recusa turma sem nível** — e é justamente a
 * turma sem nível que a A e a B existem para corrigir. Por isso cada caso que
 * precisa dela abre a transação com `ALTER COLUMN nivel_id DROP NOT NULL`, cria
 * a turma sem nível ali dentro e, no fim, desfaz tudo: a coluna volta a ser
 * `NOT NULL` junto com o resto (DDL do Postgres é transacional).
 *
 * As conferências são globais — "toda empresa sem nível", "toda turma sem
 * nível" —, e as fixturas só garantem que o universo não é vazio e que o
 * desempate da INV-075c é exercitado.
 *
 * A AC-018 prova a trava por **espera real**: uma conexão segura
 * `travarNivelDaEmpresa` de uma empresa que a migração precisa tocar, a
 * migração para nela, e a barreira vê isso pelos pids — ordem forçada por lock,
 * e não por `sleep` (a lição do FIT-020).
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
function migracao(sufixo: string): string {
  const nome = readdirSync(PASTA).find((p) => p.endsWith(sufixo));
  return readFileSync(join(PASTA, nome ?? 'ausente', 'migration.sql'), 'utf8');
}
const SQL_A = migracao('_spec079_niveis_e_primeiro_nivel');
const SQL_B = migracao('_spec079_turma_nivel_not_null');

const base = 'f0790001-0000-4000-8000-0000000000';
/** Sem nível nenhum. */
const E_SEM = `${base}01`;
/** Com níveis — empate de `ordem` que só o `created_at` desfaz —, e uma turma
 *  com um nível que NÃO é o primeiro. */
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
  await q(turma(T_COM_COM, E_COM, NV_ULTIMO));
}

function turma(id: string, emp: string, nivel: string | null): string {
  return `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${emp}','T ${id.slice(-2)}',(SELECT id FROM quadras WHERE company_id='${emp}' LIMIT 1),4,'ativa',${nivel ? `'${nivel}'` : 'NULL'})`;
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

/**
 * Abre uma transação no cliente, deixa o caso trabalhar nela, e DESFAZ.
 * `comTurmasSemNivel` tira o `NOT NULL` (desfeito junto) e cria as três turmas
 * sem nível das fixturas — o estado de antes da passagem.
 */
async function naTransacaoDesfeita(
  cliente: PrismaClient,
  corpo: (tx: Prisma.TransactionClient) => Promise<void>,
  opcoes: { comTurmasSemNivel: boolean } = { comTurmasSemNivel: true },
): Promise<void> {
  await cliente
    .$transaction(
      async (tx) => {
        if (opcoes.comTurmasSemNivel) {
          await tx.$executeRawUnsafe(
            'ALTER TABLE turmas ALTER COLUMN nivel_id DROP NOT NULL',
          );
          for (const [id, emp] of [
            [T_SEM_1, E_SEM],
            [T_SEM_2, E_SEM],
            [T_COM_SEM, E_COM],
          ]) {
            await tx.$executeRawUnsafe(turma(id, emp, null));
          }
        }
        await corpo(tx);
        throw new Desfazer();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Desfazer)) throw e;
    });
}

async function nivelDe(c: Cliente, t: string): Promise<string | null> {
  return (
    await linhas<{ nivel_id: string | null }>(
      c,
      `SELECT nivel_id FROM turmas WHERE id = '${t}'`,
    )
  )[0].nivel_id;
}

async function colunaAnulavel(c: Cliente): Promise<boolean> {
  const [r] = await linhas<{ is_nullable: string }>(
    c,
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'turmas' AND column_name = 'nivel_id'`,
  );
  return r.is_nullable === 'YES';
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

describe('SPEC-079 — as duas migrações existem, e são as de produção', () => {
  it('uma pasta de cada', () => {
    for (const sufixo of [
      '_spec079_niveis_e_primeiro_nivel',
      '_spec079_turma_nivel_not_null',
    ]) {
      expect(readdirSync(PASTA).filter((p) => p.endsWith(sufixo))).toHaveLength(
        1,
      );
    }
  });
});

describe('SPEC-079/AC-001 — o banco recusa turma sem nível', () => {
  it('a coluna é NOT NULL', async () => {
    expect(await colunaAnulavel(db)).toBe(false);
  });

  it('INSERT com nível nulo → 23502 em `nivel_id`', async () => {
    await expect(q(turma(T_SEM_1, E_COM, null))).rejects.toThrow(
      /23502|null value in column "nivel_id"/,
    );
  });

  it('UPDATE … SET nivel_id = NULL → 23502, e a turma fica como estava', async () => {
    await expect(
      q(`UPDATE turmas SET nivel_id = NULL WHERE id = '${T_COM_COM}'`),
    ).rejects.toThrow(/23502|null value in column "nivel_id"/);
    expect(await nivelDe(db, T_COM_COM)).toBe(NV_ULTIMO);
  });

  it('sabotagem no próprio teste: sem o NOT NULL (numa transação que volta), o nulo entra', async () => {
    await naTransacaoDesfeita(db, async (tx) => {
      expect(await nivelDe(tx, T_SEM_1)).toBeNull();
    });
    // …e a transação desfeita devolveu a recusa.
    expect(await colunaAnulavel(db)).toBe(false);
  });
});

describe('SPEC-079/AC-008 — a A dá os três níveis padrão, e só às empresas sem nível', () => {
  it('os nomes e as ordens do SQL são os de `NIVEIS_PADRAO`', () => {
    const valores =
      /VALUES\s*((?:\('[^']*',\s*-?\d+\)\s*,?\s*)+)\)\s*AS padrao/.exec(SQL_A);
    expect(valores).not.toBeNull();
    const tuplas = [...valores![1].matchAll(/\('([^']*)',\s*(-?\d+)\)/g)].map(
      (m) => ({ nome: m[1], ordem: Number(m[2]) }),
    );
    expect(tuplas).toEqual(NIVEIS_PADRAO);
  });

  it('toda empresa sem nível ganha os três; as que tinham não ganham nada', async () => {
    await naTransacaoDesfeita(db, async (tx) => {
      const semNivel = (
        await linhas<{ id: string }>(
          tx,
          `SELECT id FROM empresas e WHERE NOT EXISTS (SELECT 1 FROM niveis n WHERE n.company_id = e.id)`,
        )
      ).map((r) => r.id);
      expect(semNivel).toContain(E_SEM);
      const antes = await digital(tx, 'niveis', 'true');

      await tx.$executeRawUnsafe(SQL_A);

      for (const emp of semNivel) {
        const nv = await linhas<{ nome: string; ordem: number }>(
          tx,
          `SELECT nome, ordem FROM niveis WHERE company_id = '${emp}' ORDER BY ordem`,
        );
        expect(nv).toEqual(NIVEIS_PADRAO);
      }
      const lista = semNivel.map((e) => `'${e}'`).join(',');
      expect(
        await digital(tx, 'niveis', `company_id NOT IN (${lista})`),
      ).toEqual(antes);
    });
  });
});

describe('SPEC-079/AC-009 e AC-010 — o primeiro nível para toda turma sem nível, e nada mais', () => {
  it('A: cada turma sem nível recebe o primeiro da SUA empresa (INV-075c), e as outras não mudam', async () => {
    await naTransacaoDesfeita(db, async (tx) => {
      const semNivel = await linhas<{ id: string }>(
        tx,
        `SELECT id FROM turmas WHERE nivel_id IS NULL ORDER BY id`,
      );
      expect(semNivel.map((t) => t.id)).toEqual(
        expect.arrayContaining([T_SEM_1, T_SEM_2, T_COM_SEM]),
      );
      const ids = semNivel.map((t) => `'${t.id}'`).join(',');
      const comNivelAntes = await digital(tx, 'turmas', `id NOT IN (${ids})`);

      await tx.$executeRawUnsafe(SQL_A);

      const iniciante = (
        await linhas<{ id: string }>(
          tx,
          `SELECT id FROM niveis WHERE company_id = '${E_SEM}' AND nome = 'Iniciante'`,
        )
      )[0].id;
      expect(await nivelDe(tx, T_SEM_1)).toBe(iniciante);
      expect(await nivelDe(tx, T_SEM_2)).toBe(iniciante);
      // Empate de `ordem`: decide o `created_at` — o mais velho.
      expect(await nivelDe(tx, T_COM_SEM)).toBe(NV_EMPATE_VELHO);
      // A que tinha nível — e não o primeiro — fica com ele.
      expect(await nivelDe(tx, T_COM_COM)).toBe(NV_ULTIMO);
      const [{ n }] = await linhas<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM turmas WHERE nivel_id IS NULL`,
      );
      expect(n).toBe(0);
      expect(await digital(tx, 'turmas', `id NOT IN (${ids})`)).toEqual(
        comNivelAntes,
      );
    });
  });

  it('A: idempotente — rodada de novo, não escreve nada', async () => {
    await naTransacaoDesfeita(db, async (tx) => {
      await tx.$executeRawUnsafe(SQL_A);
      const niveis = await digital(tx, 'niveis', 'true');
      const turmas = await digital(tx, 'turmas', 'true');
      // O `$executeRawUnsafe` de um `DO` devolve 0 sempre: quem prova que
      // nada foi escrito são as impressões digitais.
      await tx.$executeRawUnsafe(SQL_A);
      expect(await digital(tx, 'niveis', 'true')).toEqual(niveis);
      expect(await digital(tx, 'turmas', 'true')).toEqual(turmas);
    });
  });

  it('B: repete a atribuição (a turma criada durante a troca do M2) e devolve o NOT NULL', async () => {
    await naTransacaoDesfeita(
      db,
      async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE turmas ALTER COLUMN nivel_id DROP NOT NULL',
        );
        await tx.$executeRawUnsafe(turma(T_COM_SEM, E_COM, null));
        const outras = await digital(tx, 'turmas', `id <> '${T_COM_SEM}'`);

        await tx.$executeRawUnsafe(SQL_B);

        expect(await nivelDe(tx, T_COM_SEM)).toBe(NV_EMPATE_VELHO);
        expect(await colunaAnulavel(tx)).toBe(false);
        expect(await digital(tx, 'turmas', `id <> '${T_COM_SEM}'`)).toEqual(
          outras,
        );
      },
      { comTurmasSemNivel: false },
    );
  });

  it('B: NÃO semeia nível — turma sem nível em empresa sem nível ABORTA a migração (o caso que o G1 conta)', async () => {
    // DESFEITA mesmo se a B passar: com o código errado ela passaria, e uma
    // transação que commitasse deixaria a coluna anulável para o resto da
    // suíte (aconteceu na sabotagem de tirar o `SET NOT NULL`).
    const r = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE turmas ALTER COLUMN nivel_id DROP NOT NULL',
        );
        await tx.$executeRawUnsafe(turma(T_SEM_1, E_SEM, null));
        await tx.$executeRawUnsafe(SQL_B);
        throw new Desfazer();
      })
      .then(
        () => 'passou',
        (e: unknown) => (e instanceof Desfazer ? 'passou' : String(e)),
      );
    expect(r).toMatch(/23502|contains null values/);
    // A transação abortada levou tudo: a coluna segue NOT NULL, E_SEM sem nível.
    expect(await colunaAnulavel(db)).toBe(false);
    const [{ n }] = await linhas<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM niveis WHERE company_id = '${E_SEM}'`,
    );
    expect(n).toBe(0);
  });

  it('B: idempotente — com a coluna já NOT NULL e nenhuma turma sem nível, não escreve nada', async () => {
    await naTransacaoDesfeita(
      db,
      async (tx) => {
        const turmas = await digital(tx, 'turmas', 'true');
        await tx.$executeRawUnsafe(SQL_B);
        expect(await digital(tx, 'turmas', 'true')).toEqual(turmas);
        expect(await colunaAnulavel(tx)).toBe(false);
      },
      { comTurmasSemNivel: false },
    );
  });
});

describe('SPEC-079/AC-018 — as migrações tomam a trava de nível da empresa', () => {
  /** A expressão da chave, tirada DO ARQUIVO — não uma cópia dela. */
  const expressao = (sql: string) =>
    /PERFORM pg_advisory_xact_lock\(\s*([\s\S]+?)\s*\);/.exec(sql)?.[1];

  for (const [nome, sql] of [
    ['A', SQL_A],
    ['B', SQL_B],
  ] as const) {
    it(`${nome}: a chave calculada pelo SQL da migração é a do \`travarNivelDaEmpresa\``, async () => {
      const e = expressao(sql);
      expect(e).toContain('empresa.id');
      for (const id of [
        '00000000-0000-4000-8000-000000000001',
        'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a',
        E_COM,
      ]) {
        const [r] = await linhas<{ chave: bigint }>(
          db,
          `SELECT ${e!.replace(/empresa\.id/g, `'${id}'::uuid`)} AS chave`,
        );
        expect(r.chave).toBe(ChaveDeLock.deTexto(`nivel-da-empresa:${id}`));
      }
    });
  }

  /**
   * Uma conexão segura a trava da empresa; a migração, noutra, tem de parar
   * nela. A barreira: a conexão do migrador em `wait_event = 'advisory'`,
   * bloqueada pelo pid do dono (pelos pids, e não pelo texto: o
   * `pg_stat_activity.query` corta em 1024 bytes).
   */
  async function provarEspera(
    empresa: string,
    sql: string,
    preparar: (tx: Prisma.TransactionClient) => Promise<void>,
    conferir: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    let soltar!: () => void;
    const solta = new Promise<void>((r) => (soltar = r));
    let segurando!: () => void;
    const segura = new Promise<void>((r) => (segurando = r));
    let pidDono = 0;

    const dono = db.$transaction(
      async (tx) => {
        await travarNivelDaEmpresa(tx, empresa, 'escrita');
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
    const migracao = naTransacaoDesfeita(
      migrador,
      async (tx) => {
        await preparar(tx);
        await tx.$executeRawUnsafe(sql);
        concluiu = true;
        await conferir(tx);
      },
      { comTurmasSemNivel: false },
    );

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
  }

  it('A: com a trava de uma empresa sem nível segura, a migração ESPERA, e conclui quando ela solta', async () => {
    await provarEspera(
      E_SEM,
      SQL_A,
      () => Promise.resolve(),
      async (tx) => {
        const [r] = await linhas<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM niveis WHERE company_id = '${E_SEM}'`,
        );
        expect(r.n).toBe(3);
      },
    );
  });

  it('B: com a trava de uma empresa com turma sem nível segura, a migração ESPERA, e conclui quando ela solta', async () => {
    await provarEspera(
      E_COM,
      SQL_B,
      async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE turmas ALTER COLUMN nivel_id DROP NOT NULL',
        );
        await tx.$executeRawUnsafe(turma(T_COM_SEM, E_COM, null));
      },
      async (tx) => {
        expect(await nivelDe(tx, T_COM_SEM)).toBe(NV_EMPATE_VELHO);
      },
    );
  });
});

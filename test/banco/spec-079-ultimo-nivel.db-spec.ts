/**
 * SPEC-079/REQ-007 — **o clube nunca fica sem nível** (AC-015, AC-017).
 *
 * Decisão I4 do Israel: apagar o último nível é recusado, com o texto que ele
 * aprovou (I5). Sem isso, depois da passagem, um clube podia apagar os níveis
 * que não usa e ficar sem conseguir criar turma — toda turma tem nível.
 *
 * O AC-017 é a mesma recusa **sob concorrência**: dois gestores apagam, ao
 * mesmo tempo, os dois últimos níveis. Contar e apagar sem trava deixaria os
 * dois contarem 2 e os dois apagarem. A prova força a corrida por LOCK, e não
 * por `sleep`: uma terceira conexão segura a trava de nível da empresa, as
 * duas remoções param nela, e a barreira as vê paradas — pelos pids — antes
 * de soltar.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { travarNivelDaEmpresa } from '../../src/people/nivel-efetivo';
import { LevelsService } from '../../src/people/levels.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(180_000);
exigirBancoLocal();

const db = new PrismaClient();
/** Uma conexão cada: o `pg_backend_pid()` lido fora da transação é o dela. */
const conexaoUnica = () =>
  new PrismaClient({
    datasourceUrl: `${process.env.DATABASE_URL}${process.env.DATABASE_URL?.includes('?') ? '&' : '?'}connection_limit=1`,
  });
const gestorA = conexaoUnica();
const gestorB = conexaoUnica();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const base = 'f0790002-0000-4000-8000-0000000000';
const EMPRESA = `${base}01`;
const N1 = `${base}11`;
const N2 = `${base}12`;
const QUADRA = `${base}21`;

const MENSAGEM =
  'O clube precisa de pelo menos um nível. Crie outro antes de apagar este.';

const niveis = (c: PrismaClient = db) =>
  new LevelsService(c as unknown as PrismaService);

async function montar(ids: string[]): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-079 ultimo','spec-079-u-${EMPRESA}',now())`,
  );
  for (const [i, id] of ids.entries()) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${EMPRESA}','Nível ${i + 1}',${i + 1})`,
    );
  }
}

const quantos = async () => db.nivel.count({ where: { companyId: EMPRESA } });

/** O corpo da recusa, do jeito que o cliente o recebe. */
async function recusa(p: Promise<unknown>): Promise<unknown> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(UnprocessableEntityException);
  return (e as UnprocessableEntityException).getResponse();
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await Promise.all([
    db.$disconnect(),
    gestorA.$disconnect(),
    gestorB.$disconnect(),
  ]);
});

describe('SPEC-079/AC-015 — apagar o último nível é recusado', () => {
  it('um nível só: 422 com código próprio e o texto aprovado (I5), e o nível fica', async () => {
    await montar([N1]);

    expect(await recusa(niveis().remove(EMPRESA, N1))).toEqual({
      statusCode: 422,
      code: 'ULTIMO_NIVEL_DO_CLUBE',
      message: MENSAGEM,
    });
    expect(await quantos()).toBe(1);
  });

  it('com dois, apagar um é aceito — e o que sobra passa a ser o último', async () => {
    await montar([N1, N2]);

    await niveis().remove(EMPRESA, N1);
    expect(await quantos()).toBe(1);

    expect(await recusa(niveis().remove(EMPRESA, N2))).toMatchObject({
      code: 'ULTIMO_NIVEL_DO_CLUBE',
    });
    expect(await quantos()).toBe(1);
  });

  it('o último, em uso por turma: a recusa é a do último — é ela que diz o que fazer', async () => {
    // "Mude o nível dessas turmas" não tem saída quando não existe outro
    // nível; "crie outro antes" tem.
    await montar([N1]);
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
    );
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES (gen_random_uuid(),'${EMPRESA}','T','${QUADRA}',4,'ativa','${N1}')`,
    );

    expect(await recusa(niveis().remove(EMPRESA, N1))).toMatchObject({
      code: 'ULTIMO_NIVEL_DO_CLUBE',
      message: MENSAGEM,
    });
  });
});

describe('SPEC-079/AC-017 — sob concorrência, os dois últimos', () => {
  it('dois gestores apagam os dois últimos ao mesmo tempo: um passa, o outro recebe 422, e sobra um', async () => {
    await montar([N1, N2]);
    const pid = async (c: PrismaClient) =>
      (await c.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
        .pid;
    const [pidA, pidB] = [await pid(gestorA), await pid(gestorB)];

    let soltar!: () => void;
    const solta = new Promise<void>((r) => (soltar = r));
    let segurando!: () => void;
    const segura = new Promise<void>((r) => (segurando = r));
    let pidDono = 0;
    const dono = db.$transaction(
      async (tx) => {
        await travarNivelDaEmpresa(tx, EMPRESA, 'escrita');
        pidDono = (
          await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        segurando();
        await solta;
      },
      { timeout: 120_000 },
    );
    await segura;

    const resultados = Promise.allSettled([
      niveis(gestorA).remove(EMPRESA, N1),
      niveis(gestorB).remove(EMPRESA, N2),
    ]);

    // A barreira: AS DUAS conexões paradas numa trava consultiva, cada uma
    // bloqueada pelo dono — e não por uma espera qualquer.
    const esperando = async () => {
      const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity a
          WHERE a.pid = ANY ($1::int[])
            AND a.wait_event_type = 'Lock'
            AND a.wait_event = 'advisory'
            AND $2 = ANY (pg_blocking_pids(a.pid))`,
        [pidA, pidB],
        pidDono,
      );
      return r.n === 2;
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

    soltar();
    await dono;
    const [a, b] = await resultados;
    const status = [a.status, b.status].sort();
    expect(status).toEqual(['fulfilled', 'rejected']);
    const recusada = [a, b].find((r) => r.status === 'rejected');
    expect(recusada?.reason).toBeInstanceOf(UnprocessableEntityException);
    expect(
      (recusada?.reason as UnprocessableEntityException).getResponse(),
    ).toMatchObject({ code: 'ULTIMO_NIVEL_DO_CLUBE' });
    expect(await quantos()).toBe(1);
  });
});

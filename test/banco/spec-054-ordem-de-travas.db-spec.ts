/**
 * SPEC-054/D4 — **a prova DETERMINÍSTICA da ordem de travas dos adicionais.**
 *
 * O FIT-046 (d) mostra que pedidos em ordens opostas não se travam — mas uma
 * corrida que passa pode ter passado por sorte do escalonador. Aqui a
 * intercalação é FORÇADA:
 *
 * 1. a conexão 1 recebe **da função de travas** a lista para `[A, B]`; a conexão
 *    2, para `[B, A]` — entradas opostas;
 * 2. cada uma pede o PRIMEIRO lock da sua lista;
 * 3. a barreira libera quando **cada uma tiver o lock OU estiver esperando por
 *    ele** — a espera é OBSERVADA em `pg_locks` (`granted = false`, pelo `pid`),
 *    por uma terceira conexão que só olha;
 * 4. liberadas, as duas pedem o segundo lock e confirmam.
 *
 * - **Função correta** (ordena por `id`): as duas pedem A; a 2 espera, a 1
 *   termina, a 2 termina — **as duas confirmam, nenhum `40P01`**.
 * - **Mutante S4** (ordem da entrada): a 1 segura A, a 2 segura B, e cada uma
 *   pede o que a outra tem — **`40P01` toda vez**.
 *
 * **Timeout das duas não prova nada: é falha do teste.**
 */
import { PrismaClient } from '@prisma/client';
import { ordemDeTravaDosAdicionais } from '../../src/courts/estoque-de-adicionais';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

// Três clientes: duas conexões que disputam e uma que observa. Cada uma com
// `connection_limit=1`, para a transação ser, de fato, aquela conexão.
const url = (process.env.DATABASE_URL ?? '').includes('?')
  ? `${process.env.DATABASE_URL}&connection_limit=1`
  : `${process.env.DATABASE_URL}?connection_limit=1`;
const c1 = new PrismaClient({ datasources: { db: { url } } });
const c2 = new PrismaClient({ datasources: { db: { url } } });
const observador = new PrismaClient({ datasources: { db: { url } } });

const EMPRESA = 'e0540000-0000-4000-8000-0000000000d1';
const TIPO = 'e0540000-0000-4000-8000-0000000000d2';
// A < B no texto do uuid — e é a entrada da conexão 2 que vem invertida.
const A = 'e0540000-0000-4000-8000-0000000000da';
const B = 'e0540000-0000-4000-8000-0000000000db';

const PASSO_MS = 15_000;

function comTimeout<T>(p: Promise<T>, rotulo: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout: ${rotulo}`)), PASSO_MS),
    ),
  ]);
}

async function esperaPor(pid: number): Promise<boolean> {
  const [l] = await observador.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND NOT granted`,
  );
  return l.n > 0;
}

/**
 * Uma conexão: pede a ordem à função de travas, trava o primeiro, sinaliza,
 * espera a barreira, trava o segundo, confirma.
 */
function disputar(
  cliente: PrismaClient,
  entrada: string[],
  sinal: { pid?: number; temPrimeiro: boolean },
  barreira: Promise<void>,
): Promise<string> {
  // `'confirmou'`, ou o SQLSTATE da recusa (`40P01` no mutante S4).
  return cliente
    .$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>(
          `SELECT pg_backend_pid() AS pid`,
        );
        sinal.pid = pid;
        const [primeiro, segundo] = ordemDeTravaDosAdicionais(entrada);
        await tx.$queryRawUnsafe(
          `SELECT id FROM adicionais WHERE company_id='${EMPRESA}' AND id='${primeiro}' FOR UPDATE`,
        );
        sinal.temPrimeiro = true;
        await barreira;
        await tx.$queryRawUnsafe(
          `SELECT id FROM adicionais WHERE company_id='${EMPRESA}' AND id='${segundo}' FOR UPDATE`,
        );
        return 'confirmou' as const;
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
    .catch((e: unknown) => sqlstateDoErro(e) ?? String(e));
}

beforeAll(async () => {
  await limparEmpresa(c1, EMPRESA);
  await c1.$executeRawUnsafe(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube 054 travas','clube-054-travas',now())`,
  );
  await c1.$executeRawUnsafe(
    `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES ('${TIPO}','${EMPRESA}','Bolas')`,
  );
  await c1.$executeRawUnsafe(
    `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at) VALUES
      ('${A}','${EMPRESA}','${TIPO}','A',5,1,now()),('${B}','${EMPRESA}','${TIPO}','B',5,1,now())`,
  );
});

afterAll(async () => {
  await limparEmpresa(c1, EMPRESA);
  await Promise.all([
    c1.$disconnect(),
    c2.$disconnect(),
    observador.$disconnect(),
  ]);
});

describe('SPEC-054/D4 — a ordem das travas, com a intercalação forçada', () => {
  it('a função de travas devolve a MESMA sequência para entradas opostas', () => {
    expect(ordemDeTravaDosAdicionais([A, B])).toEqual(
      ordemDeTravaDosAdicionais([B, A]),
    );
  });

  it.each([1, 2, 3])(
    'rodada %i: com a barreira observada em pg_locks, as duas confirmam e nenhuma dá 40P01',
    async () => {
      const s1: { pid?: number; temPrimeiro: boolean } = { temPrimeiro: false };
      const s2: { pid?: number; temPrimeiro: boolean } = { temPrimeiro: false };
      let liberar!: () => void;
      const barreira = new Promise<void>((r) => (liberar = r));

      const p1 = disputar(c1, [A, B], s1, barreira);
      const p2 = disputar(c2, [B, A], s2, barreira);

      // A barreira: cada conexão TEM o primeiro lock ou ESPERA por ele —
      // observado, não suposto.
      await comTimeout(
        (async () => {
          for (;;) {
            const pronto1 =
              s1.temPrimeiro ||
              (s1.pid !== undefined && (await esperaPor(s1.pid)));
            const pronto2 =
              s2.temPrimeiro ||
              (s2.pid !== undefined && (await esperaPor(s2.pid)));
            if (pronto1 && pronto2) return;
            await new Promise((r) => setTimeout(r, 20));
          }
        })(),
        'barreira',
      );
      liberar();

      const desfechos = await comTimeout(Promise.all([p1, p2]), 'desfecho');
      expect(desfechos).toEqual(['confirmou', 'confirmou']);
    },
  );
});

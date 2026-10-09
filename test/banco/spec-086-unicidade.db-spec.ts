/**
 * SPEC-086/AC-001 — **a regra nova de e-mail, pela migration real, sobre o
 * schema inteiro.**
 *
 * Os 16 pares ordenados de papel (super_admin, company_admin, aluno,
 * professor) × mesma/outra empresa dão 32 casos. Só aluno/professor × aluno/
 * professor em empresas DIFERENTES grava; todo o resto é recusado — e cada
 * recusa sai da constraint certa, porque é por ela que o tradutor reconhece o
 * erro (matriz de falha da spec).
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

const A = '08600000-0000-4000-8001-000000000001';
const B = '08600000-0000-4000-8001-000000000002';
const EMAIL = 'spec086-unicidade@teste.local';
const PAPEIS = ['super_admin', 'company_admin', 'aluno', 'professor'] as const;
type Papel = (typeof PAPEIS)[number];

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const ehGestao = (p: Papel) => p === 'super_admin' || p === 'company_admin';

function empresaDe(p: Papel, empresa: string): string | null {
  return p === 'super_admin' ? null : empresa;
}

async function limparContas() {
  await q(`DELETE FROM usuarios WHERE email = '${EMAIL}'`);
}

async function criar(p: Papel, empresa: string | null) {
  return db.usuario.create({
    data: {
      email: EMAIL,
      senhaHash: 'x',
      nome: 'spec-086',
      role: p,
      companyId: empresa,
    },
    select: { id: true },
  });
}

/** A constraint que recusou, lida da forma real do erro (State, fato 12). */
function constraintDe(erro: unknown): string {
  const e = erro as {
    code?: string;
    meta?: { target?: string[] };
    message?: string;
  };
  if (e.code === 'P2002') {
    const alvo = (e.meta?.target ?? []).join(',');
    if (alvo === 'company_id,email') return 'usuarios_company_id_email_key';
    if (alvo === 'email') return 'usuarios_email_gestao_key';
    return `P2002:${alvo}`;
  }
  if (e.message?.includes('usuarios_email_gestao_excl')) {
    return 'usuarios_email_gestao_excl';
  }
  return `outro:${e.code ?? '?'}`;
}

beforeAll(async () => {
  await limparContas();
  await limparEmpresa(db, A);
  await limparEmpresa(db, B);
  for (const [id, slug] of [
    [A, 'spec-086-unicidade-a'],
    [B, 'spec-086-unicidade-b'],
  ]) {
    await q(
      comNivelDaFixture(
        `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${id}','${slug}','${slug}',now())`,
      ),
    );
  }
});

afterEach(limparContas);

afterAll(async () => {
  await limparContas();
  await limparEmpresa(db, A);
  await limparEmpresa(db, B);
  await db.$disconnect();
});

const casos: [Papel, Papel, boolean][] = [];
for (const p1 of PAPEIS) {
  for (const p2 of PAPEIS) {
    for (const mesma of [true, false]) casos.push([p1, p2, mesma]);
  }
}

describe('SPEC-086/AC-001 — os 32 pares, pela migration real', () => {
  it('são 32 casos', () => {
    expect(casos).toHaveLength(32);
  });

  it.each(casos)('%s × %s, mesma empresa = %s', async (p1, p2, mesma) => {
    await criar(p1, empresaDe(p1, A));
    const segunda = criar(p2, empresaDe(p2, mesma ? A : B));

    const permitido = !ehGestao(p1) && !ehGestao(p2) && !mesma;
    if (permitido) {
      await expect(segunda).resolves.toHaveProperty('id');
      return;
    }

    const erro = await segunda.then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).not.toBeNull();
    // Duas contas da MESMA empresa esbarram primeiro no índice por empresa,
    // mesmo quando a regra de gestão também recusaria: o Postgres reporta a
    // primeira violação que encontra. O super admin não tem empresa e nunca
    // cai nesse índice.
    const mesmaEmpresa = mesma && p1 !== 'super_admin' && p2 !== 'super_admin';
    const esperada = mesmaEmpresa
      ? 'usuarios_company_id_email_key'
      : ehGestao(p1) && ehGestao(p2)
        ? 'usuarios_email_gestao_key'
        : ehGestao(p1) || ehGestao(p2)
          ? 'usuarios_email_gestao_excl'
          : 'usuarios_company_id_email_key';
    expect(constraintDe(erro)).toBe(esperada);
  });

  it('o índice global antigo não existe mais, e os três novos existem', async () => {
    const indices = await db.$queryRawUnsafe<{ nome: string }[]>(
      `SELECT indexname AS nome FROM pg_indexes
        WHERE tablename = 'usuarios' AND indexname LIKE 'usuarios_%email%'
        ORDER BY 1`,
    );
    expect(indices.map((i) => i.nome)).toEqual([
      'usuarios_company_id_email_key',
      'usuarios_email_gestao_excl',
      'usuarios_email_gestao_key',
    ]);
  });
});

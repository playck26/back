/**
 * SPEC-090/TASK-001 — **o pedido de redefinição contra o banco de verdade**
 * (D2), e a limpeza dos testes que ele exige.
 *
 * Nada do que está em julgamento aqui existe em TypeScript: duas tabelas, três
 * índices, um CHECK e duas FKs, e o passo fixo de `limparEmpresa` para o
 * pedido órfão. Um mock não tem constraint — por isso cada prova é SQL direto,
 * escrito por alguém que ignorou os serviços (que nem existem ainda: a emissão
 * é da TASK-002). Mesmo molde do `spec-083-convites-de-acesso.db-spec.ts`.
 *
 * ## AC-001 — a migration real
 *
 * O catálogo do Postgres, e não o `schema.prisma`: o que vale é o que a
 * migration criou. E as duas recusas que importam — o `super_admin` (D7) e a
 * cascata pedido → contas — com o SQLSTATE **e** a constraint exatos, pelo
 * mesmo bloco `DO` do 083 (a mensagem do Prisma não traz o nome da
 * constraint; ver o cabeçalho daquele arquivo).
 *
 * ## AC-028 — a limpeza, só banco
 *
 * Um pedido com contas nas empresas A e B, e um pedido órfão ALHEIO (sem conta,
 * e que nunca teve conta de A nem de B). As três sabotagens da D2 ficam
 * vermelhas aqui, cada uma numa asserção diferente:
 *
 * - S17 (apagar o pedido quando ele tem ALGUMA conta da empresa limpa): o
 *   pedido A+B some ao limpar A;
 * - S18 (sem o passo fixo dos órfãos): o pedido A+B sobra depois de limpar B;
 * - S22 (o passo fixo sem o limite `p.id = ANY(...)`): o órfão alheio some ao
 *   limpar A.
 *
 * A parte HTTP (o `GET` devolve só B depois de limpar A) é o AC-030, da
 * TASK-002.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const base = 'c0900001-0000-4000-8000-0000000000';
const EMPRESA_A = `${base}0a`;
const EMPRESA_B = `${base}0b`;
const ALUNO_A = `${base}2a`;
/** Professor na B, com o MESMO e-mail do aluno da A (SPEC-086). */
const PROFESSOR_B = `${base}2b`;
/** `company_id` NULO — o `usuarios_company_id_role_check` exige isso dele. */
const SUPER_ADMIN = `${base}f1`;

/** O pedido que cobre A e B. */
const PEDIDO_AB = `${base}5a`;
/**
 * O órfão ALHEIO: nenhuma conta, e nunca teve conta de A nem de B. Existe em
 * produção depois de um `DELETE` manual em `usuarios` (D2), e nos canários do
 * Neon DEV pode ser de outra suíte — a limpeza de A não tem nada com ele.
 */
const PEDIDO_ORFAO_ALHEIO = `${base}5f`;

const EMAIL_DAS_CONTAS = 'spec090-redefinicao@teste.local';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const ler = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

/** O diagnóstico do Postgres, relançado como texto (ver o 083). */
function comDiagnostico(sql: string): string {
  return `DO $diag$
DECLARE s text; c text; k text;
BEGIN
  ${sql};
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, c = COLUMN_NAME, k = CONSTRAINT_NAME;
  RAISE EXCEPTION 'recusado sqlstate=% coluna=% constraint=%', s, c, k;
END $diag$`;
}

async function recusa(
  sql: string,
  esperado: { sqlstate: string; coluna?: string; constraint?: string },
): Promise<void> {
  const erro: unknown = await q(comDiagnostico(sql)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  const mensagem =
    (erro as { meta?: { message?: string } }).meta?.message ?? '';
  const achado = /recusado sqlstate=(\w*) coluna=(\S*) constraint=(\S*)/.exec(
    mensagem,
  );
  expect(achado === null ? mensagem : 'diagnostico lido').toBe(
    'diagnostico lido',
  );
  const [, sqlstate, coluna, constraint] = achado ?? [];
  expect({ sqlstate, coluna, constraint }).toEqual({
    sqlstate: esperado.sqlstate,
    coluna: esperado.coluna ?? '',
    constraint: esperado.constraint ?? '',
  });
}

let seq = 0;

/** Um pedido vivo, vencendo em 60 min, com `token_hash` novo a cada chamada. */
function pedido(
  opcoes: {
    id?: string;
    emailResultado?: 'enviado' | 'falhou';
    emailEm?: boolean;
  } = {},
): string {
  seq += 1;
  return `INSERT INTO pedidos_de_redefinicao
      (id,email,token_hash,expira_em,email_resultado,email_em)
    VALUES (${opcoes.id ? `'${opcoes.id}'` : 'gen_random_uuid()'},
            '${EMAIL_DAS_CONTAS}','hash-090-${seq}-${Date.now()}',
            now() + interval '60 minutes',
            ${opcoes.emailResultado ? `'${opcoes.emailResultado}'` : 'NULL'},
            ${opcoes.emailEm ? 'now()' : 'NULL'})`;
}

function conta(pedidoId: string, empresa: string, usuario: string): string {
  return `INSERT INTO contas_da_redefinicao
      (pedido_id,company_id,usuario_id,impressao_credencial)
    VALUES ('${pedidoId}','${empresa}','${usuario}','impressao')`;
}

async function linhasDoPedido(id: string): Promise<number> {
  const [linha] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM pedidos_de_redefinicao WHERE id = '${id}'`,
  );
  return linha.n;
}

async function contasDoPedido(id: string): Promise<string[]> {
  const linhas = await ler<{ company_id: string }>(
    `SELECT company_id::text AS company_id FROM contas_da_redefinicao
      WHERE pedido_id = '${id}' ORDER BY company_id`,
  );
  return linhas.map((l) => l.company_id);
}

/**
 * Fora do alcance de `limparEmpresa` de propósito: o super admin não tem
 * empresa, e o órfão alheio não tem conta. Por isso saem por id.
 */
async function apagarForaDaEmpresa(): Promise<void> {
  await q(`DELETE FROM usuarios WHERE id = '${SUPER_ADMIN}'`);
  await q(
    `DELETE FROM pedidos_de_redefinicao WHERE id IN ('${PEDIDO_AB}','${PEDIDO_ORFAO_ALHEIO}')`,
  );
}

async function montar(): Promise<void> {
  for (const [empresa, nome] of [
    [EMPRESA_A, 'a'],
    [EMPRESA_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresa}','SPEC-090 redefinicao ${nome}','spec-090-redefinicao-${nome}-${empresa}',now())`,
    );
  }
  for (const [usuario, papel, empresa, email] of [
    [ALUNO_A, 'aluno', `'${EMPRESA_A}'`, EMAIL_DAS_CONTAS],
    [PROFESSOR_B, 'professor', `'${EMPRESA_B}'`, EMAIL_DAS_CONTAS],
    [SUPER_ADMIN, 'super_admin', 'NULL', 'spec090-redefinicao-sa@teste.local'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ('${usuario}','${email}','x','U','${papel}',${empresa},now())`,
    );
  }
}

async function desmontar(): Promise<void> {
  for (const empresa of [EMPRESA_A, EMPRESA_B]) {
    await limparEmpresa(db, empresa);
  }
  await apagarForaDaEmpresa();
}

afterAll(async () => {
  await desmontar();
  await db.$disconnect();
});

describe('SPEC-090/TASK-001 — AC-001: as tabelas da redefinição, pela migration real', () => {
  beforeAll(async () => {
    await desmontar();
    await montar();
  });

  beforeEach(() =>
    q(`DELETE FROM pedidos_de_redefinicao WHERE email = '${EMAIL_DAS_CONTAS}'`),
  );

  it('as duas tabelas existem', async () => {
    const linhas = await ler<{ tabela: string }>(
      `SELECT table_name::text AS tabela FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('pedidos_de_redefinicao','contas_da_redefinicao')
        ORDER BY table_name`,
    );
    expect(linhas.map((l) => l.tabela)).toEqual([
      'contas_da_redefinicao',
      'pedidos_de_redefinicao',
    ]);
  });

  it('os índices: o único do token, o do teto (email, criado_em) e a PK composta das contas', async () => {
    const linhas = await ler<{ indice: string; definicao: string }>(
      `SELECT indexname::text AS indice, indexdef AS definicao FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('pedidos_de_redefinicao','contas_da_redefinicao')
        ORDER BY indexname`,
    );
    // As duas PKs também são índices; a lista inteira, sem sobra nem falta.
    expect(linhas.map((l) => l.indice)).toEqual([
      'contas_da_redefinicao_pkey',
      'pedidos_de_redefinicao_email_criado_em_idx',
      'pedidos_de_redefinicao_pkey',
      'pedidos_de_redefinicao_token_hash_key',
    ]);
    const def = Object.fromEntries(linhas.map((l) => [l.indice, l.definicao]));
    expect(def['pedidos_de_redefinicao_token_hash_key']).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(token_hash\)$/,
    );
    expect(def['pedidos_de_redefinicao_email_criado_em_idx']).toMatch(
      /^CREATE INDEX .* USING btree \(email, criado_em\)$/,
    );
    expect(def['contas_da_redefinicao_pkey']).toMatch(
      /^CREATE UNIQUE INDEX .* USING btree \(pedido_id, usuario_id\)$/,
    );
  });

  it('o CHECK e as duas FKs, com as ações de DELETE e UPDATE da D2', async () => {
    const linhas = await ler<{ nome: string; definicao: string }>(
      `SELECT conname::text AS nome, pg_get_constraintdef(oid) AS definicao
         FROM pg_constraint
        WHERE conrelid IN ('pedidos_de_redefinicao'::regclass,
                           'contas_da_redefinicao'::regclass)
          AND contype IN ('c','f')
        ORDER BY conname`,
    );
    expect(linhas).toEqual([
      {
        nome: 'contas_da_redefinicao_pedido_id_fkey',
        definicao:
          'FOREIGN KEY (pedido_id) REFERENCES pedidos_de_redefinicao(id) ON DELETE CASCADE',
      },
      {
        nome: 'contas_da_redefinicao_usuario_fkey',
        definicao:
          'FOREIGN KEY (company_id, usuario_id) REFERENCES usuarios(company_id, id) ON DELETE CASCADE',
      },
      {
        nome: 'pedidos_de_redefinicao_email_coerente',
        definicao: 'CHECK (((email_resultado IS NULL) = (email_em IS NULL)))',
      },
    ]);
  });

  it('controle: uma conta de aluno da empresa entra no pedido', async () => {
    // Sem este controle, as recusas abaixo poderiam ser de um INSERT
    // malformado, e não do usuário de `company_id` nulo.
    await q(pedido({ id: PEDIDO_AB }));
    await q(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A));
    expect(await contasDoPedido(PEDIDO_AB)).toEqual([EMPRESA_A]);
  });

  it('D7 — o super_admin, forjando a empresa A → 23503 na FK composta', async () => {
    await q(pedido({ id: PEDIDO_AB }));
    await recusa(conta(PEDIDO_AB, EMPRESA_A, SUPER_ADMIN), {
      sqlstate: '23503',
      constraint: 'contas_da_redefinicao_usuario_fkey',
    });
    expect(await contasDoPedido(PEDIDO_AB)).toEqual([]);
  });

  it('D7 — o super_admin, com o company_id dele (nulo) → 23502 em company_id', async () => {
    await q(pedido({ id: PEDIDO_AB }));
    await recusa(
      `INSERT INTO contas_da_redefinicao
         (pedido_id,company_id,usuario_id,impressao_credencial)
       VALUES ('${PEDIDO_AB}',NULL,'${SUPER_ADMIN}','impressao')`,
      { sqlstate: '23502', coluna: 'company_id' },
    );
  });

  it('a conta não cruza empresa: company_id da A com o professor da B → 23503', async () => {
    await q(pedido({ id: PEDIDO_AB }));
    await recusa(conta(PEDIDO_AB, EMPRESA_A, PROFESSOR_B), {
      sqlstate: '23503',
      constraint: 'contas_da_redefinicao_usuario_fkey',
    });
  });

  it('a mesma conta duas vezes no mesmo pedido → 23505 na PK', async () => {
    await q(pedido({ id: PEDIDO_AB }));
    await q(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A));
    await recusa(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A), {
      sqlstate: '23505',
      constraint: 'contas_da_redefinicao_pkey',
    });
  });

  it('token_hash repetido → 23505 no único do token', async () => {
    await q(
      `INSERT INTO pedidos_de_redefinicao (email,token_hash,expira_em)
       VALUES ('${EMAIL_DAS_CONTAS}','hash-090-repetido',now() + interval '1 hour')`,
    );
    await recusa(
      `INSERT INTO pedidos_de_redefinicao (email,token_hash,expira_em)
       VALUES ('${EMAIL_DAS_CONTAS}','hash-090-repetido',now() + interval '1 hour')`,
      {
        sqlstate: '23505',
        constraint: 'pedidos_de_redefinicao_token_hash_key',
      },
    );
  });

  it('email_coerente — resultado sem instante, e instante sem resultado → 23514; os dois juntos passam', async () => {
    await recusa(pedido({ emailResultado: 'enviado' }), {
      sqlstate: '23514',
      constraint: 'pedidos_de_redefinicao_email_coerente',
    });
    await recusa(pedido({ emailEm: true }), {
      sqlstate: '23514',
      constraint: 'pedidos_de_redefinicao_email_coerente',
    });
    await q(pedido({ emailResultado: 'falhou', emailEm: true }));
    await q(pedido());
    const linhas = await ler<{ resultado: string | null; tem_em: boolean }>(
      `SELECT email_resultado::text AS resultado, email_em IS NOT NULL AS tem_em
         FROM pedidos_de_redefinicao WHERE email = '${EMAIL_DAS_CONTAS}'
        ORDER BY email_resultado NULLS LAST`,
    );
    expect(linhas).toEqual([
      { resultado: 'falhou', tem_em: true },
      { resultado: null, tem_em: false },
    ]);
  });

  it('apagar o pedido apaga as contas dele (CASCADE pedido → contas)', async () => {
    await q(pedido({ id: PEDIDO_AB }));
    await q(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A));
    await q(conta(PEDIDO_AB, EMPRESA_B, PROFESSOR_B));
    expect(await contasDoPedido(PEDIDO_AB)).toEqual([EMPRESA_A, EMPRESA_B]);

    await q(`DELETE FROM pedidos_de_redefinicao WHERE id = '${PEDIDO_AB}'`);
    expect(await contasDoPedido(PEDIDO_AB)).toEqual([]);
  });

  it('não há cascata reversa: apagar a última conta deixa o pedido órfão (D2)', async () => {
    // É por isto que a limpeza dos testes precisa de um passo próprio para o
    // pedido — e que o órfão de produção fica no banco (LIM-090-04).
    await q(pedido({ id: PEDIDO_AB }));
    await q(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A));
    await q(
      `DELETE FROM contas_da_redefinicao WHERE pedido_id = '${PEDIDO_AB}'`,
    );
    expect(await linhasDoPedido(PEDIDO_AB)).toBe(1);
  });
});

describe('SPEC-090/TASK-001 — AC-028: a limpeza dos testes, com o pedido A+B e o órfão alheio', () => {
  beforeAll(async () => {
    await desmontar();
    await montar();
    await q(pedido({ id: PEDIDO_AB }));
    await q(conta(PEDIDO_AB, EMPRESA_A, ALUNO_A));
    await q(conta(PEDIDO_AB, EMPRESA_B, PROFESSOR_B));
    await q(pedido({ id: PEDIDO_ORFAO_ALHEIO }));
  });

  it('controle: antes da limpeza, o pedido A+B tem as duas contas e o órfão alheio nenhuma', async () => {
    expect(await contasDoPedido(PEDIDO_AB)).toEqual([EMPRESA_A, EMPRESA_B]);
    expect(await linhasDoPedido(PEDIDO_ORFAO_ALHEIO)).toBe(1);
    expect(await contasDoPedido(PEDIDO_ORFAO_ALHEIO)).toEqual([]);
  });

  it('limparEmpresa(A): apaga a conta de A, MANTÉM o pedido A+B com a conta de B (S17), e o órfão alheio (S22)', async () => {
    await limparEmpresa(db, EMPRESA_A);

    expect(await contasDoPedido(PEDIDO_AB)).toEqual([EMPRESA_B]);
    expect(await linhasDoPedido(PEDIDO_AB)).toBe(1);
    expect(await linhasDoPedido(PEDIDO_ORFAO_ALHEIO)).toBe(1);
  });

  it('limparEmpresa(B) depois: ZERO linhas do pedido A+B (S18), e o órfão alheio continua', async () => {
    await limparEmpresa(db, EMPRESA_B);

    expect(await contasDoPedido(PEDIDO_AB)).toEqual([]);
    expect(await linhasDoPedido(PEDIDO_AB)).toBe(0);
    expect(await linhasDoPedido(PEDIDO_ORFAO_ALHEIO)).toBe(1);
  });
});

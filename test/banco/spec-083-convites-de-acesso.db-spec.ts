/**
 * SPEC-083/TASK-002 — **o convite de acesso contra o banco de verdade** (D6).
 *
 * Nada do que está em julgamento aqui existe em TypeScript: um índice único
 * PARCIAL, dois CHECK, uma FK composta, uma FK simples, um UNIQUE e um NOT
 * NULL. Um mock não tem constraint — por isso cada prova é SQL direto, escrito
 * por alguém que ignorou todos os serviços (que nem existem ainda: a emissão é
 * da TASK-004). Mesmo molde do `spec-074-constraints.db-spec.ts`.
 *
 * ## Recusado com o SQLSTATE exato E pela constraint exata
 *
 * As duas coisas: um `INSERT` que morresse por outro motivo passaria verde por
 * qualquer `rejects`. **E aqui a mensagem do Prisma não basta, medido em
 * 2026-10-03:** no `23502` ele entrega só o DETAIL (`Failing row contains
 * (...)`), sem o nome da coluna; no `23505` entrega `Key (usuario_id)=...`,
 * sem o nome do índice — e esta tabela tem DOIS únicos que dão `23505`.
 *
 * Por isso a recusa passa por um bloco `DO` que lê o diagnóstico do próprio
 * Postgres (`GET STACKED DIAGNOSTICS`: SQLSTATE, coluna e constraint) e o
 * relança como texto. **Relança com o código padrão do `RAISE` (`P0001`), e
 * não com o original, de propósito:** com `23502` ou `23505` o Prisma
 * reescreve a mensagem a partir do código (`Unique constraint failed: `) e o
 * diagnóstico some — também medido. O SQLSTATE comparado é o ORIGINAL, lido
 * pelo Postgres, e não o do relançamento.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const base = 'c0830002-0000-4000-8000-0000000000';
const EMPRESA_A = `${base}0a`;
const EMPRESA_B = `${base}0b`;
/** Quem emite: o gestor da empresa A. */
const GESTOR_A = `${base}1a`;
const ALUNO_A = `${base}2a`;
const ALUNO_A2 = `${base}2c`;
const ALUNO_B = `${base}2b`;
/** `company_id` NULO — o `usuarios_company_id_role_check` exige isso dele. */
const SUPER_ADMIN = `${base}f1`;

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const ler = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

/** O diagnóstico do Postgres, relançado como texto (ver o cabeçalho). */
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
  // Sem o diagnóstico, o erro veio de outro lugar (o próprio bloco, a
  // conexão): falha aqui, com a mensagem crua, em vez de comparar vazio.
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

/**
 * Um convite, por padrão VIVO (nem usado nem revogado), da empresa A para o
 * `ALUNO_A`, emitido pelo `GESTOR_A`, vencendo em 7 dias. O `token_hash` é
 * novo a cada chamada, para só o índice em julgamento poder recusar.
 */
function convite(
  opcoes: {
    empresa?: string | null;
    usuario?: string;
    criador?: string;
    token?: string;
    expirado?: boolean;
    usado?: boolean;
    revogado?: boolean;
    emailResultado?: 'enviado' | 'falhou';
    emailEm?: boolean;
  } = {},
): string {
  seq += 1;
  const empresa =
    opcoes.empresa === null ? 'NULL' : `'${opcoes.empresa ?? EMPRESA_A}'`;
  return `INSERT INTO convites_de_acesso
      (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,
       expira_em,usado_em,revogado_em,email_resultado,email_em)
    VALUES (${empresa},'${opcoes.usuario ?? ALUNO_A}','${opcoes.criador ?? GESTOR_A}',
            '${opcoes.token ?? `hash-${seq}`}','impressao',
            now() + interval '${opcoes.expirado ? '-1 day' : '7 days'}',
            ${opcoes.usado ? 'now()' : 'NULL'},${opcoes.revogado ? 'now()' : 'NULL'},
            ${opcoes.emailResultado ? `'${opcoes.emailResultado}'` : 'NULL'},
            ${opcoes.emailEm ? 'now()' : 'NULL'})`;
}

async function quantos(usuario: string): Promise<number> {
  const [linha] = await ler<{ n: number }>(
    `SELECT count(*)::int AS n FROM convites_de_acesso WHERE usuario_id = '${usuario}'`,
  );
  return linha.n;
}

/** O `super_admin` não tem empresa: `limparEmpresa` nunca o alcança. */
const apagarSuperAdmin = () =>
  q(`DELETE FROM usuarios WHERE id = '${SUPER_ADMIN}'`);

async function montar(): Promise<void> {
  for (const [empresa, nome] of [
    [EMPRESA_A, 'a'],
    [EMPRESA_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresa}','SPEC-083 convites ${nome}','spec-083-convites-${nome}-${empresa}',now())`,
    );
  }
  for (const [usuario, papel, empresa, sufixo] of [
    [GESTOR_A, 'company_admin', `'${EMPRESA_A}'`, 'gestor-a'],
    [ALUNO_A, 'aluno', `'${EMPRESA_A}'`, 'aluno-a'],
    [ALUNO_A2, 'aluno', `'${EMPRESA_A}'`, 'aluno-a2'],
    [ALUNO_B, 'aluno', `'${EMPRESA_B}'`, 'aluno-b'],
    [SUPER_ADMIN, 'super_admin', 'NULL', 'sa'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,senha_temporaria,updated_at)
       VALUES ('${usuario}','spec083-convites-${sufixo}@teste.local','x','U','${papel}',${empresa},true,now())`,
    );
  }
}

beforeAll(async () => {
  for (const empresa of [EMPRESA_A, EMPRESA_B]) {
    await limparEmpresa(db, empresa);
  }
  await apagarSuperAdmin();
  await montar();
});

beforeEach(() =>
  q(
    `DELETE FROM convites_de_acesso WHERE company_id IN ('${EMPRESA_A}','${EMPRESA_B}')`,
  ),
);

afterAll(async () => {
  for (const empresa of [EMPRESA_A, EMPRESA_B]) {
    await limparEmpresa(db, empresa);
  }
  await apagarSuperAdmin();
  await db.$disconnect();
});

describe('SPEC-083/TASK-002 — o convite de acesso, como o banco o garante', () => {
  // ========================================================================
  // AC-039 / INV-083d — o super_admin nunca tem convite
  // ========================================================================

  it('AC-039 — controle: o mesmo INSERT, para um usuário da empresa, passa', async () => {
    // Sem este controle, as duas recusas abaixo poderiam ser de um INSERT
    // malformado, e não do usuário de `company_id` nulo.
    await q(convite({}));
    expect(await quantos(ALUNO_A)).toBe(1);
  });

  it('AC-039 — convite para o super_admin, com o company_id dele (nulo) → 23502 em company_id', async () => {
    await recusa(convite({ empresa: null, usuario: SUPER_ADMIN }), {
      sqlstate: '23502',
      coluna: 'company_id',
    });
  });

  it('AC-039 — convite para o super_admin, forjando a empresa A → 23503 na FK composta', async () => {
    await recusa(convite({ empresa: EMPRESA_A, usuario: SUPER_ADMIN }), {
      sqlstate: '23503',
      constraint: 'convites_de_acesso_usuario_fkey',
    });
    expect(await quantos(SUPER_ADMIN)).toBe(0);
  });

  // ========================================================================
  // INV-083b — no máximo UM convite vivo por usuário, e o índice é PARCIAL
  // ========================================================================

  it('INV-083b — dois convites vivos do mesmo usuário → 23505 no índice parcial', async () => {
    await q(convite({}));
    await recusa(convite({}), {
      sqlstate: '23505',
      constraint: 'convites_de_acesso_um_vivo_por_usuario',
    });
    expect(await quantos(ALUNO_A)).toBe(1);
  });

  it('INV-083b — um REVOGADO mais um vivo passa', async () => {
    await q(convite({ revogado: true }));
    await q(convite({}));
    expect(await quantos(ALUNO_A)).toBe(2);
  });

  it('INV-083b — um USADO mais um vivo passa', async () => {
    await q(convite({ usado: true }));
    await q(convite({}));
    expect(await quantos(ALUNO_A)).toBe(2);
  });

  it('INV-083b — um EXPIRADO e não usado continua vivo para o índice, e bloqueia o segundo → 23505', async () => {
    await q(convite({ expirado: true }));
    await recusa(convite({}), {
      sqlstate: '23505',
      constraint: 'convites_de_acesso_um_vivo_por_usuario',
    });
    expect(await quantos(ALUNO_A)).toBe(1);
  });

  it('INV-083b — revogar o expirado e emitir o novo, na mesma transação, passa (o gesto do reenvio, D9)', async () => {
    await q(convite({ expirado: true }));
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE convites_de_acesso SET revogado_em = now()
          WHERE usuario_id = '${ALUNO_A}' AND usado_em IS NULL AND revogado_em IS NULL`,
      );
      await tx.$executeRawUnsafe(convite({}));
    });
    const [linha] = await ler<{ vivos: number; total: number }>(
      `SELECT count(*) FILTER (WHERE usado_em IS NULL AND revogado_em IS NULL)::int AS vivos,
              count(*)::int AS total
         FROM convites_de_acesso WHERE usuario_id = '${ALUNO_A}'`,
    );
    expect(linha).toEqual({ vivos: 1, total: 2 });
  });

  it('INV-083b é por USUÁRIO — outro usuário da mesma empresa tem o seu vivo ao mesmo tempo', async () => {
    await q(convite({}));
    await q(convite({ usuario: ALUNO_A2 }));
    expect(await quantos(ALUNO_A)).toBe(1);
    expect(await quantos(ALUNO_A2)).toBe(1);
  });

  // ========================================================================
  // CHECK convites_de_acesso_fim_unico — usado OU revogado, nunca os dois
  // ========================================================================

  it('fim_unico — INSERT usado E revogado → 23514', async () => {
    await recusa(convite({ usado: true, revogado: true }), {
      sqlstate: '23514',
      constraint: 'convites_de_acesso_fim_unico',
    });
  });

  it('fim_unico — revogar um convite já USADO → 23514 (o reenvio não pode reescrever o fim)', async () => {
    await q(convite({ usado: true }));
    await recusa(
      `UPDATE convites_de_acesso SET revogado_em = now() WHERE usuario_id = '${ALUNO_A}'`,
      { sqlstate: '23514', constraint: 'convites_de_acesso_fim_unico' },
    );
  });

  // ========================================================================
  // CHECK convites_de_acesso_email_coerente — resultado e instante juntos
  // ========================================================================

  it('email_coerente — email_resultado sem email_em → 23514', async () => {
    await recusa(convite({ emailResultado: 'enviado' }), {
      sqlstate: '23514',
      constraint: 'convites_de_acesso_email_coerente',
    });
  });

  it('email_coerente — email_em sem email_resultado → 23514 (o CHECK vale nos dois sentidos)', async () => {
    await recusa(convite({ emailEm: true }), {
      sqlstate: '23514',
      constraint: 'convites_de_acesso_email_coerente',
    });
  });

  it('email_coerente — os dois juntos passam, e os dois nulos também (o `sem_confirmacao` da D8)', async () => {
    await q(convite({ emailResultado: 'falhou', emailEm: true }));
    await q(convite({ usuario: ALUNO_A2 }));
    const linhas = await ler<{ resultado: string | null; tem_em: boolean }>(
      `SELECT email_resultado::text AS resultado, email_em IS NOT NULL AS tem_em
         FROM convites_de_acesso WHERE company_id = '${EMPRESA_A}'
        ORDER BY email_resultado NULLS LAST`,
    );
    expect(linhas).toEqual([
      { resultado: 'falhou', tem_em: true },
      { resultado: null, tem_em: false },
    ]);
  });

  // ========================================================================
  // As FKs e o token — o resto da D6
  // ========================================================================

  it('FK composta — company_id da empresa A com usuario_id da empresa B → 23503', async () => {
    await recusa(convite({ empresa: EMPRESA_A, usuario: ALUNO_B }), {
      sqlstate: '23503',
      constraint: 'convites_de_acesso_usuario_fkey',
    });
  });

  it('token_hash duplicado → 23505 no UNIQUE do token (dois usuários, para o índice parcial não morder antes)', async () => {
    await q(convite({ token: 'hash-repetido' }));
    await recusa(convite({ usuario: ALUNO_A2, token: 'hash-repetido' }), {
      sqlstate: '23505',
      constraint: 'convites_de_acesso_token_hash_key',
    });
  });

  it('criado_por_id de usuário inexistente → 23503 na FK de quem emitiu', async () => {
    await recusa(convite({ criador: `${base}ff` }), {
      sqlstate: '23503',
      constraint: 'convites_de_acesso_criado_por_fkey',
    });
  });

  it('apagar o usuário leva os convites dele junto (ON DELETE CASCADE da FK composta)', async () => {
    const descartavel = `${base}3a`;
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
       VALUES ('${descartavel}','spec083-convites-descartavel@teste.local','x','U','aluno','${EMPRESA_A}',now())`,
    );
    await q(convite({ usuario: descartavel, revogado: true }));
    await q(convite({ usuario: descartavel }));
    expect(await quantos(descartavel)).toBe(2);

    await q(`DELETE FROM usuarios WHERE id = '${descartavel}'`);
    expect(await quantos(descartavel)).toBe(0);
  });

  it('apagar o gestor que emitiu é recusado → 23503 (NO ACTION: o banco não decide por ele)', async () => {
    await q(convite({}));
    await recusa(`DELETE FROM usuarios WHERE id = '${GESTOR_A}'`, {
      sqlstate: '23503',
      constraint: 'convites_de_acesso_criado_por_fkey',
    });
    expect(await quantos(ALUNO_A)).toBe(1);
  });
});

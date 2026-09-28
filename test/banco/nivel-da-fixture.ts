/**
 * SPEC-079/D4 — **toda turma tem nível, inclusive a das fixturas.**
 *
 * Desde a migração B, `turmas.nivel_id` é `NOT NULL`: uma fixtura que cria
 * turma sem nível morre com `23502` antes de chegar ao que queria provar. E
 * turma só tem nível se a empresa tiver um — empresa criada por SQL não passa
 * pelo `CompaniesService.create`, e nasce sem nenhum.
 *
 * Por isso a fixtura cria a empresa por aqui, **junto com o nível**, numa
 * instrução só (um CTE): não há como esquecer um e lembrar do outro. E a turma
 * aponta para o primeiro nível da sua empresa (INV-075c) pela subconsulta
 * `PRIMEIRO_NIVEL_SQL`, sem precisar carregar o id do nível até ali.
 *
 * O nível da fixtura é UM, com `ordem` 0: aluno sem nível conta como o
 * primeiro (SPEC-075/D1), então aluno sem nível e turma da fixtura continuam
 * compatíveis — o nível não muda o que as fixturas antigas provavam. Quem
 * testa nível cria os seus.
 */

/** O nome do nível que toda empresa de fixtura ganha. */
export const NOME_DO_NIVEL_DA_FIXTURE = 'Nível da fixtura';

/**
 * Embrulha um `INSERT INTO empresas (...) VALUES (...)` para criar também o
 * nível da fixtura. Se o `INSERT` não inserir (um `ON CONFLICT DO NOTHING`
 * numa segunda rodada), o nível também não entra — a empresa já existia, e
 * com ele.
 */
export function comNivelDaFixture(insertDeEmpresa: string): string {
  return `WITH empresa_da_fixtura AS (${insertDeEmpresa} RETURNING id)
INSERT INTO niveis (id, company_id, nome, ordem)
SELECT gen_random_uuid(), id, '${NOME_DO_NIVEL_DA_FIXTURE}', 0 FROM empresa_da_fixtura`;
}

/**
 * O primeiro nível de uma empresa (INV-075c: `ordem`, `created_at`, `id`),
 * como subconsulta para o `VALUES` de um `INSERT INTO turmas`. `empresa` é a
 * expressão SQL do `company_id`, do jeito que ela está no `VALUES`.
 */
export function primeiroNivelSql(empresa: string): string {
  return `(SELECT id FROM niveis WHERE company_id = ${empresa} ORDER BY ordem, created_at, id LIMIT 1)`;
}

/** Para quem precisa do id: o primeiro nível da empresa, criando o da
 *  fixtura se ela não tiver nenhum. */
export async function nivelDaFixture(
  db: {
    $queryRawUnsafe<T = unknown>(sql: string, ...v: unknown[]): Promise<T>;
  },
  empresaId: string,
): Promise<string> {
  await db.$queryRawUnsafe(
    `INSERT INTO niveis (id, company_id, nome, ordem)
     SELECT gen_random_uuid(), $1::uuid, $2, 0
      WHERE NOT EXISTS (SELECT 1 FROM niveis WHERE company_id = $1::uuid)`,
    empresaId,
    NOME_DO_NIVEL_DA_FIXTURE,
  );
  const [r] = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM niveis WHERE company_id = $1::uuid
      ORDER BY ordem, created_at, id LIMIT 1`,
    empresaId,
  );
  return r.id;
}

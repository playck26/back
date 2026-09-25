/**
 * SPEC-075/TASK-001 — **o nível não cruza empresa, e apagar um nível em uso é
 * recusado** (D9, INV-075d, INV-075e), contra o banco de verdade.
 *
 * As provas de FK são SQL direto, escrito por alguém que ignorou os serviços:
 * o serviço sempre conferiu a empresa do nível (`students.service.ts`,
 * `classes.service.ts`), e o que está em julgamento aqui é o banco recusar
 * **sem** ele. Mesmo molde do `spec-074-constraints.db-spec.ts`: recusado com o
 * SQLSTATE certo **e** pela constraint certa — uma escrita que morresse por
 * outro motivo passaria verde por qualquer `rejects`.
 *
 * Cada recusa tem o seu **controle**: a mesma escrita, com o nível da própria
 * empresa, passa. Sem o controle, uma fixture torta ficaria vermelha pelo
 * motivo errado e o teste passaria.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { LevelsService } from '../../src/people/levels.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA_A = '075c0750-0000-4000-8000-00000000000a';
const EMPRESA_B = '075c0750-0000-4000-8000-00000000000b';
const QUADRA_A = '075c0750-0000-4000-8000-00000000001a';
const USUARIO_A = '075c0750-0000-4000-8000-00000000002a';
const ALUNO_A = '075c0750-0000-4000-8000-00000000003a';
/** Nível da empresa A. */
const NIVEL_A = '075c0750-0000-4000-8000-00000000004a';
/** Nível da empresa B — o intruso das provas de FK. */
const NIVEL_B = '075c0750-0000-4000-8000-00000000004b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const ler = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);
const niveis = new LevelsService(db as unknown as PrismaService);

function textoDoErro(erro: unknown): string {
  const e = erro as { message?: string; meta?: unknown };
  return `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
}

async function recusa(
  sql: string,
  sqlstate: string,
  constraint: string,
): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  const texto = textoDoErro(erro);
  expect(texto).toContain(sqlstate);
  expect(texto).toContain(constraint);
}

let seq = 0;
function novoId(): string {
  seq += 1;
  return `075c0750-0000-4000-8000-1${String(seq).padStart(11, '0')}`;
}

function nivel(id: string, empresa: string, nome: string, ordem = 1): string {
  return `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${empresa}','${nome}',${ordem})`;
}

function turma(nivelId: string | null, id = novoId()): string {
  return `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,nivel_id)
    VALUES ('${id}','${EMPRESA_A}','T ${id.slice(-4)}','${QUADRA_A}',10,${nivelId ? `'${nivelId}'` : 'NULL'})`;
}

function convite(nivelId: string | null, id = novoId()): string {
  return `INSERT INTO convites_aluno (id,company_id,criado_por_id,nivel_id,token_hash,expira_em)
    VALUES ('${id}','${EMPRESA_A}','${USUARIO_A}',${nivelId ? `'${nivelId}'` : 'NULL'},
            'spec075-${id}',now() + interval '7 days')`;
}

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA_A, 'A'],
    [EMPRESA_B, 'B'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-075 ${nome}','spec-075-${nome.toLowerCase()}-${emp}',now())`,
    );
  }
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA_A}','${EMPRESA_A}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA_A}' LIMIT 1),80)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO_A}','spec075-a@teste.local','x','U','aluno','${EMPRESA_A}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO_A}','${USUARIO_A}','${EMPRESA_A}','aprovado')`,
  );
  await q(nivel(NIVEL_A, EMPRESA_A, 'Iniciante'));
  await q(nivel(NIVEL_B, EMPRESA_B, 'Iniciante'));
}

/** Volta ao estado de `montar()`: nenhuma turma, nenhum convite, o aluno sem
 *  nível, e só os dois níveis de base. **O nível de base é RECRIADO se faltar**:
 *  com a FK sabotada (`SET NULL` no lugar de `RESTRICT`), o caso de turma apaga
 *  o nível de verdade — e sem recriá-lo os casos seguintes cairiam por fixture,
 *  não pela regra, e a sabotagem derrubaria mais casos do que os seus. */
async function limparCasos(): Promise<void> {
  await q(`DELETE FROM convites_aluno WHERE company_id = '${EMPRESA_A}'`);
  await q(`DELETE FROM turmas WHERE company_id = '${EMPRESA_A}'`);
  await q(`UPDATE alunos SET nivel_id = NULL WHERE id = '${ALUNO_A}'`);
  await q(
    `DELETE FROM niveis WHERE company_id = '${EMPRESA_A}' AND id <> '${NIVEL_A}'`,
  );
  await q(
    `${nivel(NIVEL_A, EMPRESA_A, 'Iniciante')} ON CONFLICT (id) DO NOTHING`,
  );
}

beforeAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await montar();
});

beforeEach(limparCasos);

afterAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

describe('SPEC-075/TASK-001 — o nível, como o banco o garante', () => {
  // ========================================================================
  // AC-014 / INV-075d — o nível não cruza empresa, nas três tabelas
  // ========================================================================

  it('AC-014 — aluno com o nível de OUTRA empresa → 23503 pela alunos_nivel_fkey', async () => {
    await recusa(
      `UPDATE alunos SET nivel_id = '${NIVEL_B}' WHERE id = '${ALUNO_A}'`,
      '23503',
      'alunos_nivel_fkey',
    );
    // controle: o nível da própria empresa passa
    await q(
      `UPDATE alunos SET nivel_id = '${NIVEL_A}' WHERE id = '${ALUNO_A}'`,
    );
  });

  it('AC-014 — turma com o nível de OUTRA empresa → 23503 pela turmas_nivel_fkey', async () => {
    await recusa(turma(NIVEL_B), '23503', 'turmas_nivel_fkey');
    await q(turma(NIVEL_A));
  });

  it('AC-014 — convite com o nível de OUTRA empresa → 23503 pela convites_nivel_fkey', async () => {
    await recusa(convite(NIVEL_B), '23503', 'convites_nivel_fkey');
    await q(convite(NIVEL_A));
  });

  it('AC-014 — nível nulo NÃO é conferido (MATCH SIMPLE): aluno, turma e convite sem nível passam', async () => {
    await q(turma(null));
    await q(convite(null));
    const [linha] = await ler<{ n: bigint }>(
      `SELECT count(*) AS n FROM alunos WHERE id = '${ALUNO_A}' AND nivel_id IS NULL`,
    );
    expect(Number(linha.n)).toBe(1);
  });

  // ========================================================================
  // AC-015 / INV-075e — apagar nível em uso: o serviço explica, o banco garante
  // ========================================================================

  it('AC-015 — nível usado por TURMA: o serviço recusa com 422 e mensagem', async () => {
    await q(turma(NIVEL_A));

    const erro = await niveis.remove(EMPRESA_A, NIVEL_A).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(UnprocessableEntityException);
    expect((erro as Error).message).toContain('em uso por turma');
  });

  // **`23001`, e não `23503`** — achado ao rodar, contra o que a spec
  // escreveu na AC-015: o PostgreSQL devolve `restrict_violation` (23001) para
  // `ON DELETE RESTRICT`, e `foreign_key_violation` (23503) só para `NO
  // ACTION`. O comportamento é o da spec (o banco recusa, pela constraint
  // certa); o código é que estava errado nela. Registrado no CLI_AUDIT.
  it('AC-015 — nível usado por TURMA: o banco recusa sozinho → 23001 pela turmas_nivel_fkey', async () => {
    await q(turma(NIVEL_A));
    await recusa(
      `DELETE FROM niveis WHERE id = '${NIVEL_A}'`,
      '23001',
      'turmas_nivel_fkey',
    );
  });

  it('AC-015 — nível usado por ALUNO: o serviço recusa com 422', async () => {
    await q(
      `UPDATE alunos SET nivel_id = '${NIVEL_A}' WHERE id = '${ALUNO_A}'`,
    );

    await expect(niveis.remove(EMPRESA_A, NIVEL_A)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('AC-015 — nível usado por ALUNO: o banco recusa sozinho → 23001 pela alunos_nivel_fkey', async () => {
    await q(
      `UPDATE alunos SET nivel_id = '${NIVEL_A}' WHERE id = '${ALUNO_A}'`,
    );
    await recusa(
      `DELETE FROM niveis WHERE id = '${NIVEL_A}'`,
      '23001',
      'alunos_nivel_fkey',
    );
  });

  // ========================================================================
  // AC-016 — convite não segura o nível: só o `nivel_id` dele fica nulo
  // ========================================================================

  it('AC-016 — apagar nível usado só por CONVITE passa, e só o nivel_id do convite fica nulo', async () => {
    const OUTRO = novoId();
    await q(nivel(OUTRO, EMPRESA_A, 'Avançado', 3));
    const CONVITE = novoId();
    await q(convite(OUTRO, CONVITE));

    await niveis.remove(EMPRESA_A, OUTRO);

    const [linha] = await ler<{ nivel_id: string | null; company_id: string }>(
      `SELECT nivel_id, company_id::text AS company_id FROM convites_aluno WHERE id = '${CONVITE}'`,
    );
    expect(linha.nivel_id).toBeNull();
    // `SET NULL` sem lista de colunas anularia também `company_id` (NOT NULL)
    // e o DELETE morreria com 23502 — é a lista `(nivel_id)` que este caso
    // prova.
    expect(linha.company_id).toBe(EMPRESA_A);
    const [restou] = await ler<{ n: bigint }>(
      `SELECT count(*) AS n FROM niveis WHERE id = '${OUTRO}'`,
    );
    expect(Number(restou.n)).toBe(0);
  });
});

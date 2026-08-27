import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';

/**
 * SPEC-020/TASK-007 — **FIT-009: o ensaio do backfill dos catálogos.**
 *
 * ## Por que este arquivo existe depois da migration já ter rodado
 *
 * O backfill da `..._spec020_catalogos_de_quadra_expand` aplicou em produção
 * em 2026-08-26. A parte arriscada dele não é o `INSERT`: é a **dedup por
 * `lower(nome)` sobre a união de duas fontes que nunca se falaram**, com
 * regra de desempate para a grafia exibida. Isso não estava provado por
 * nenhum teste — o `catalogos-de-quadra.db-spec.ts` prova as constraints que
 * ficaram, não a transformação que as encheu.
 *
 * Migration que já rodou não fica dispensada de prova. Se a dedup estivesse
 * errada, o dano **já estaria em produção** e ninguém saberia dizer onde: o
 * sintoma seria "tenis" e "Tenis" como duas opções na tela de alguém, ou uma
 * quadra apontando para a opção da grafia errada.
 *
 * ## Como ele ensaia o que não existe mais
 *
 * A `..._contract` derrubou `quadras.esporte` e `empresas.esportes` em
 * 2026-08-26 — as duas fontes que o backfill lia. **O ensaio não pode rodar
 * contra o schema atual**, então ele reconstrói o estado PRÉ-migration num
 * schema descartável e roda ali.
 *
 * **O SQL não é copiado: é lido da própria migration.** Uma cópia divergiria
 * do arquivo no primeiro ajuste e passaria a provar outra coisa que ninguém
 * roda. Se o formato do arquivo mudar, a extração falha alto em vez de
 * silenciosamente ensaiar metade.
 */

jest.setTimeout(60_000);

// Antes de qualquer conexão: esta suíte cria e derruba schema.
exigirBancoLocal();

const prisma = new PrismaClient();

/** Schema descartável. Nunca `public` — ali moram as outras suítes. */
const SCHEMA = 'ensaio_fit009';

const EMPRESA_A = 'aaaaaaaa-0000-4000-8000-000000090001';
const EMPRESA_B = 'bbbbbbbb-0000-4000-8000-000000090002';

/**
 * O trecho de backfill da migration da expand, lido do disco.
 *
 * Começa no `WITH fontes AS (` — tudo acima é DDL, que este ensaio recria à
 * mão em forma mínima. Termina no fim do arquivo, incluindo o bloco `DO $$`
 * que é a asserção embutida na própria migration.
 */
function sqlDoBackfill(): string {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const pasta = readdirSync(dir).find((d) =>
    d.endsWith('spec020_catalogos_de_quadra_expand'),
  );
  if (!pasta) {
    throw new Error(
      'A migration da expand da SPEC-020 não foi encontrada. Se ela foi ' +
        'renomeada, este ensaio precisa saber — ele existe para provar o ' +
        'SQL dela, não uma cópia.',
    );
  }
  const sql = readFileSync(join(dir, pasta, 'migration.sql'), 'utf8');
  const inicio = sql.indexOf('WITH fontes AS (');
  if (inicio === -1) {
    throw new Error(
      'O backfill mudou de forma: `WITH fontes AS (` não está mais na ' +
        'migration. Reveja este ensaio antes de mudar o marcador.',
    );
  }
  return sql.slice(inicio);
}

/**
 * Separa por `;`, respeitando `$$ ... $$`.
 *
 * O `DO $$` da asserção tem ponto e vírgula dentro. Um `split(';')` ingênuo o
 * quebraria em pedaços que não compilam — e o teste passaria a falhar por
 * motivo que não tem nada a ver com o backfill.
 */
function comandos(sql: string): string[] {
  const saida: string[] = [];
  let atual = '';
  let dentroDeDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      dentroDeDollar = !dentroDeDollar;
      atual += '$$';
      i++;
      continue;
    }
    const c = sql[i];
    if (c === ';' && !dentroDeDollar) {
      if (atual.trim()) saida.push(atual);
      atual = '';
      continue;
    }
    atual += c;
  }
  if (atual.trim()) saida.push(atual);
  return saida;
}

const COMANDOS = comandos(sqlDoBackfill());

/** O estado PRÉ-migration, em forma mínima: só o que o backfill lê e escreve. */
async function recriarEstadoPreMigration(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${SCHEMA}.empresas (
      id uuid PRIMARY KEY,
      esportes text[] NOT NULL DEFAULT '{}'
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${SCHEMA}.quadras (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES ${SCHEMA}.empresas(id),
      esporte text NOT NULL DEFAULT '',
      esporte_id uuid,
      categoria_id uuid
    )`);
  // A UNIQUE por (company_id, nome) é a mesma da migration, e está aqui de
  // propósito: se a dedup falhar, o ensaio não devolve "duas linhas" — o
  // banco recusa o INSERT, que é o que aconteceria em produção.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${SCHEMA}.esportes_de_quadra (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      nome text NOT NULL,
      ordem integer NOT NULL DEFAULT 0,
      created_at timestamp(3) NOT NULL DEFAULT now(),
      UNIQUE (company_id, nome)
    )`);
}

async function empresa(id: string, esportes: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${SCHEMA}.empresas (id, esportes) VALUES ($1::uuid, $2::text[])`,
    id,
    esportes,
  );
}

async function quadra(
  id: string,
  companyId: string,
  esporte: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${SCHEMA}.quadras (id, company_id, esporte)
     VALUES ($1::uuid, $2::uuid, $3)`,
    id,
    companyId,
    esporte,
  );
}

/**
 * Roda o backfill da migration contra o schema do ensaio.
 *
 * `SET LOCAL search_path` numa transação interativa, porque o SQL da
 * migration usa nomes sem qualificar — é assim que ele roda em produção, e
 * qualificar aqui provaria um SQL diferente do que subiu.
 *
 * `timeout` explícito: o padrão do Prisma é 5000 ms, e foi ele que derrubou a
 * criação de turma no DEF-013. Aqui a transação é pequena, mas deixar o
 * número escrito é mais barato que descobrir de novo.
 */
async function rodarBackfill(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}`);
      for (const comando of COMANDOS) {
        await tx.$executeRawUnsafe(comando);
      }
    },
    { timeout: 30_000 },
  );
}

async function opcoesDe(companyId: string) {
  return prisma.$queryRawUnsafe<{ nome: string; ordem: number }[]>(
    `SELECT nome, ordem FROM ${SCHEMA}.esportes_de_quadra
     WHERE company_id = $1::uuid ORDER BY ordem`,
    companyId,
  );
}

async function esporteDaQuadra(id: string): Promise<string | null> {
  const linhas = await prisma.$queryRawUnsafe<{ nome: string | null }[]>(
    `SELECT e.nome
     FROM ${SCHEMA}.quadras q
     LEFT JOIN ${SCHEMA}.esportes_de_quadra e ON e.id = q.esporte_id
     WHERE q.id = $1::uuid`,
    id,
  );
  return linhas[0]?.nome ?? null;
}

describe('FIT-009 — o backfill dos catálogos, contra Postgres real', () => {
  beforeEach(async () => {
    await recriarEstadoPreMigration();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await prisma.$disconnect();
  });

  it('o ensaio roda o SQL da migration, e ele tem a forma esperada', () => {
    // Três comandos: o INSERT da união, o UPDATE que aponta as quadras e o
    // `DO $$` que aborta se sobrar quadra órfã. Se um sumir, o ensaio estaria
    // provando menos do que anuncia — e calado sobre isso.
    expect(COMANDOS).toHaveLength(3);
    expect(COMANDOS[0]).toContain('INSERT INTO esportes_de_quadra');
    expect(COMANDOS[1]).toContain('UPDATE quadras');
    expect(COMANDOS[2]).toContain('RAISE EXCEPTION');
  });

  it('AC-010: "tenis" em duas empresas vira DUAS opções, uma por empresa', async () => {
    await empresa(EMPRESA_A, ['tenis']);
    await empresa(EMPRESA_B, ['tenis']);

    await rodarBackfill();

    expect(await opcoesDe(EMPRESA_A)).toEqual([{ nome: 'tenis', ordem: 0 }]);
    expect(await opcoesDe(EMPRESA_B)).toEqual([{ nome: 'tenis', ordem: 0 }]);
  });

  it('AC-012: a união preserva o esporte declarado que não tem quadra', async () => {
    // O clube declarou tênis e padel, e só construiu a quadra de tênis. Um
    // backfill que lesse só as quadras faria o padel sumir na migration — e
    // ninguém notaria, porque nada na tela some quando some uma opção vazia.
    await empresa(EMPRESA_A, ['tenis', 'padel']);
    const QUADRA = 'aa000001-0000-4000-8000-000000090011';
    await quadra(QUADRA, EMPRESA_A, 'tenis');

    await rodarBackfill();

    expect(await opcoesDe(EMPRESA_A)).toEqual([
      { nome: 'padel', ordem: 0 },
      { nome: 'tenis', ordem: 1 },
    ]);
    expect(await esporteDaQuadra(QUADRA)).toBe('tenis');
  });

  it('AC-012: nome nas DUAS fontes vira UMA opção, e a grafia declarada vence', async () => {
    // É o defeito que originou a SPEC-020: a mesma modalidade escrita de dois
    // jeitos. `empresas.esportes` foi digitado de propósito por uma pessoa;
    // `quadras.esporte` foi redigitado a cada cadastro — por isso a prioridade.
    await empresa(EMPRESA_A, ['Tênis']);
    const Q1 = 'aa000002-0000-4000-8000-000000090012';
    const Q2 = 'aa000003-0000-4000-8000-000000090013';
    await quadra(Q1, EMPRESA_A, 'tênis');
    await quadra(Q2, EMPRESA_A, '  TÊNIS  ');

    await rodarBackfill();

    expect(await opcoesDe(EMPRESA_A)).toEqual([{ nome: 'Tênis', ordem: 0 }]);
    // E as duas quadras acham a opção, apesar da grafia diferente.
    expect(await esporteDaQuadra(Q1)).toBe('Tênis');
    expect(await esporteDaQuadra(Q2)).toBe('Tênis');
  });

  it('AC-010: nenhuma quadra com esporte preenchido fica sem esporte_id', async () => {
    await empresa(EMPRESA_A, ['tenis']);
    await empresa(EMPRESA_B, []);
    await quadra('aa000004-0000-4000-8000-000000090014', EMPRESA_A, 'tenis');
    await quadra(
      'aa000005-0000-4000-8000-000000090015',
      EMPRESA_A,
      'Beach Tennis',
    );
    await quadra('bb000001-0000-4000-8000-000000090021', EMPRESA_B, 'padel');

    await rodarBackfill();

    const [{ orfas }] = await prisma.$queryRawUnsafe<{ orfas: bigint }[]>(
      `SELECT count(*) AS orfas FROM ${SCHEMA}.quadras
       WHERE btrim(esporte) <> '' AND esporte_id IS NULL`,
    );
    expect(Number(orfas)).toBe(0);
  });

  it('quadra com esporte EM BRANCO fica de fora e a migration NÃO aborta', async () => {
    // Não há nome para catalogar. Sair como erro faria a migration recusar de
    // subir por causa de um dado que a TASK-004 (NOT NULL) é quem cobra.
    await empresa(EMPRESA_A, ['tenis']);
    const VAZIA = 'aa000006-0000-4000-8000-000000090016';
    await quadra(VAZIA, EMPRESA_A, '   ');

    await expect(rodarBackfill()).resolves.toBeUndefined();
    expect(await esporteDaQuadra(VAZIA)).toBeNull();
  });

  /**
   * **A asserção embutida não é decorativa** — e isso não se prova rodando o
   * backfill inteiro, porque o `UPDATE` sempre fecha: as opções nascem das
   * próprias quadras. O único jeito honesto é montar o estado que a asserção
   * existe para barrar e rodar só ela.
   */
  it('a asserção da própria migration ABORTA quando sobra quadra órfã', async () => {
    await empresa(EMPRESA_A, []);
    await quadra('aa000007-0000-4000-8000-000000090017', EMPRESA_A, 'tenis');

    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}`);
          // Só o `DO $$`: as quadras estão sem `esporte_id` porque o INSERT e
          // o UPDATE não rodaram.
          await tx.$executeRawUnsafe(COMANDOS[2]);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/SPEC-020\/AC-010/);
  });
});

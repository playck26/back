import { Prisma } from '@prisma/client';
import {
  FOLGA_DO_TIMEOUT_MS,
  MARCADOR_DO_PRAZO,
  PRAZO_DA_MATRICULA_MS,
} from '../../common/lock/prazo-de-espera';
import { PRAZO_DA_TRAVA_DE_EMAIL_MS } from '../../acesso/trava-de-email';
import { travarNivelDaEmpresa } from '../nivel-efetivo';
import { TIMEOUT_DA_IMPORTACAO_MS } from './importacao-de-alunos.service';
import {
  CUSTO_DA_INSTRUCAO_FRIA_MS,
  ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS,
  MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO,
  PRAZO_DA_IMPORTACAO_MS,
} from './prazo-da-importacao';

/**
 * DEF-040 — **o prazo da importação, a conta dele, e quem grava qual prazo.**
 *
 * A prova de que o teto de instruções é o que a transação faz de verdade mora
 * no banco (`test/banco/spec-083-importacao.db-spec.ts`, que conta), e a do
 * valor gravado na sessão também (`test/banco/def-040-prazo-da-importacao.db-spec.ts`).
 * Aqui: a aritmética, e o número que cada modo da trava do clube manda ao
 * `set_config('playck.prazo', …)`.
 */
describe('DEF-040 — o prazo da importação', () => {
  it('é 2 s de espera + teto de instruções × custo da instrução fria — 6.690 ms', () => {
    expect(PRAZO_DA_IMPORTACAO_MS).toBe(
      ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS +
        MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO * CUSTO_DA_INSTRUCAO_FRIA_MS,
    );
    expect([
      ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS,
      MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO,
      CUSTO_DA_INSTRUCAO_FRIA_MS,
      PRAZO_DA_IMPORTACAO_MS,
    ]).toEqual([2_000, 14, 335, 6_690]);
  });

  it('a matrícula continua com 2 s, e os dois prazos são diferentes', () => {
    expect(PRAZO_DA_MATRICULA_MS).toBe(2_000);
    expect(PRAZO_DA_IMPORTACAO_MS).not.toBe(PRAZO_DA_MATRICULA_MS);
  });

  it('o `timeout` da transação cobre o BEGIN, a trava de e-mail, o prazo dela e o da importação, com folga', () => {
    // BEGIN e a instrução da trava de e-mail, frias; os 5 s da trava de
    // e-mail; o prazo da importação (que já conta até o COMMIT); 1 s de folga.
    const piorCaso =
      2 * CUSTO_DA_INSTRUCAO_FRIA_MS +
      PRAZO_DA_TRAVA_DE_EMAIL_MS +
      PRAZO_DA_IMPORTACAO_MS +
      FOLGA_DO_TIMEOUT_MS;
    expect(piorCaso).toBe(13_360);
    expect(TIMEOUT_DA_IMPORTACAO_MS).toBeGreaterThan(piorCaso);
  });
});

/** Um cliente de transação que só registra a instrução da trava. */
function clienteQueRegistra() {
  const instrucoes: Prisma.Sql[] = [];
  // Chamado como função (`$queryRaw(sql)`) ou como template marcado
  // (`$executeRaw\`…\``): os dois viram um `Prisma.Sql`.
  const registrar = (q: Prisma.Sql | TemplateStringsArray, v: unknown[]) =>
    instrucoes.push(
      Array.isArray(q)
        ? Prisma.sql(q as TemplateStringsArray, ...(v as Prisma.Sql[]))
        : (q as Prisma.Sql),
    );
  const db = {
    $queryRaw: (q: Prisma.Sql | TemplateStringsArray, ...v: unknown[]) => {
      registrar(q, v);
      return Promise.resolve([{ ok: 1 }]);
    },
    $executeRaw: (q: Prisma.Sql | TemplateStringsArray, ...v: unknown[]) => {
      registrar(q, v);
      return Promise.resolve(0);
    },
  } as unknown as Parameters<typeof travarNivelDaEmpresa>[0];
  return { db, instrucoes };
}

/** Os valores da instrução que grava `playck.prazo` (há uma só). */
function valoresDoPrazo(instrucoes: readonly Prisma.Sql[]): unknown[] {
  const comPrazo = instrucoes.filter((i) =>
    i.sql.includes(`set_config('${MARCADOR_DO_PRAZO}'`),
  );
  expect(comPrazo).toHaveLength(1);
  return comPrazo[0].values;
}

describe('DEF-040 — cada modo da trava do clube grava o seu prazo', () => {
  it(`o modo da importação (\`lote-novo\`) grava ${PRAZO_DA_IMPORTACAO_MS} ms, e não os 2 s da matrícula`, async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'lote-novo');
    const valores = valoresDoPrazo(instrucoes);
    expect(valores).toContain(PRAZO_DA_IMPORTACAO_MS);
    expect(valores).not.toContain(PRAZO_DA_MATRICULA_MS);
  });

  it('o modo da matrícula (`leitura`) continua gravando 2 s, e não o prazo da importação', async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'leitura', 'a1');
    const valores = valoresDoPrazo(instrucoes);
    expect(valores).toContain(PRAZO_DA_MATRICULA_MS);
    expect(valores).not.toContain(PRAZO_DA_IMPORTACAO_MS);
  });

  it('o modo `escrita` (catálogo de níveis) não grava prazo nenhum', async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'escrita');
    expect(
      instrucoes.filter((i) => i.sql.includes(MARCADOR_DO_PRAZO)),
    ).toHaveLength(0);
  });
});

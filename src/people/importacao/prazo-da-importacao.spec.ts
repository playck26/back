import { Prisma } from '@prisma/client';
import {
  FOLGA_DO_TIMEOUT_MS,
  MARCADOR_DO_PRAZO,
  PRAZO_DA_MATRICULA_MS,
} from '../../common/lock/prazo-de-espera';
import { PRAZO_DA_TRAVA_DE_EMAIL_MS } from '../../acesso/trava-de-email';
import {
  TIMEOUT_DA_EDICAO_DE_NIVEL,
  TIMEOUT_DA_EDICAO_DE_NIVEL_MS,
  travarNivelDaEmpresa,
} from '../nivel-efetivo';
import { TIMEOUT_DA_IMPORTACAO_MS } from './importacao-de-alunos.service';
import {
  CUSTO_DA_INSTRUCAO_FRIA_MS,
  ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS,
  MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO,
  POSSE_MAXIMA_DA_TRAVA_DO_CLUBE_PELA_IMPORTACAO_MS,
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

  it('o `timeout` da transação cobre o BEGIN, a trava de e-mail, o prazo dela e a posse máxima da trava do clube, com folga', () => {
    // BEGIN e a instrução da trava de e-mail, frias; os 5 s da trava de
    // e-mail; da trava do clube ao COMMIT, a posse máxima — o prazo E a rede
    // das instruções depois de uma espera que o comeu, que o
    // `statement_timeout` não mede (revisão do 512025f); 1 s de folga.
    //
    // Sem número literal aqui: subir o teto sobe o pior caso junto, e o
    // teste só fica vermelho se o `timeout` deixar de cobri-lo.
    const piorCaso =
      2 * CUSTO_DA_INSTRUCAO_FRIA_MS +
      PRAZO_DA_TRAVA_DE_EMAIL_MS +
      POSSE_MAXIMA_DA_TRAVA_DO_CLUBE_PELA_IMPORTACAO_MS +
      FOLGA_DO_TIMEOUT_MS;
    expect(TIMEOUT_DA_IMPORTACAO_MS).toBeGreaterThan(piorCaso);
  });

  it('a posse máxima da trava do clube é o prazo + o teto de instruções pagando a rede de novo', () => {
    expect(POSSE_MAXIMA_DA_TRAVA_DO_CLUBE_PELA_IMPORTACAO_MS).toBe(
      PRAZO_DA_IMPORTACAO_MS +
        MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO * CUSTO_DA_INSTRUCAO_FRIA_MS,
    );
  });

  it('quem edita nível (modo `escrita`, sem `lock_timeout`) aceita esperar a posse máxima da importação, além dos 5 s do próprio trabalho', () => {
    expect(TIMEOUT_DA_EDICAO_DE_NIVEL_MS).toBe(
      5_000 +
        POSSE_MAXIMA_DA_TRAVA_DO_CLUBE_PELA_IMPORTACAO_MS +
        FOLGA_DO_TIMEOUT_MS,
    );
    expect(TIMEOUT_DA_EDICAO_DE_NIVEL).toEqual({
      timeout: TIMEOUT_DA_EDICAO_DE_NIVEL_MS,
    });
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

/**
 * **O prazo que o SQL grava, e não só o número entre os parâmetros**
 * (revisão do 512025f: `${PRAZO}::int / 3 * interval …` ou `interval '1
 * second'` mantinham o número nos parâmetros e mudavam o prazo). O texto da
 * instrução tem de ser exatamente `clock_timestamp() + $n::int * interval
 * '1 millisecond'` dentro do `set_config` do marcador, e o `$n` é o número
 * devolvido.
 */
function prazoGravadoEmMs(instrucoes: readonly Prisma.Sql[]): unknown {
  const comPrazo = instrucoes.filter((i) =>
    i.sql.includes(`set_config('${MARCADOR_DO_PRAZO}'`),
  );
  expect(comPrazo).toHaveLength(1);
  const texto = comPrazo[0].text.replace(/\s+/g, ' ');
  const antes = `set_config('${MARCADOR_DO_PRAZO}', (clock_timestamp() + $`;
  const depois = `::int * interval '1 millisecond')::text, true)`;
  const inicio = texto.indexOf(antes);
  expect(inicio).toBeGreaterThanOrEqual(0);
  const numero = /^\d+/.exec(texto.slice(inicio + antes.length));
  expect(numero).not.toBeNull();
  const fim = inicio + antes.length + numero![0].length;
  expect(texto.slice(fim, fim + depois.length)).toBe(depois);
  return comPrazo[0].values[Number(numero![0]) - 1];
}

describe('DEF-040 — cada modo da trava do clube grava o seu prazo', () => {
  it(`o modo da importação (\`lote-novo\`) grava ${PRAZO_DA_IMPORTACAO_MS} ms, e não os 2 s da matrícula`, async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'lote-novo');
    const valores = valoresDoPrazo(instrucoes);
    expect(valores).toContain(PRAZO_DA_IMPORTACAO_MS);
    expect(valores).not.toContain(PRAZO_DA_MATRICULA_MS);
    expect(prazoGravadoEmMs(instrucoes)).toBe(PRAZO_DA_IMPORTACAO_MS);
  });

  it('o modo da matrícula (`leitura`) continua gravando 2 s, e não o prazo da importação', async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'leitura', 'a1');
    const valores = valoresDoPrazo(instrucoes);
    expect(valores).toContain(PRAZO_DA_MATRICULA_MS);
    expect(valores).not.toContain(PRAZO_DA_IMPORTACAO_MS);
    expect(prazoGravadoEmMs(instrucoes)).toBe(PRAZO_DA_MATRICULA_MS);
  });

  it('o modo `escrita` (catálogo de níveis) não grava prazo nenhum', async () => {
    const { db, instrucoes } = clienteQueRegistra();
    await travarNivelDaEmpresa(db, 'c1', 'escrita');
    expect(
      instrucoes.filter((i) => i.sql.includes(MARCADOR_DO_PRAZO)),
    ).toHaveLength(0);
  });
});

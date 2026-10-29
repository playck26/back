/**
 * DEF-040 — **o prazo da importação é dela, e não o da matrícula.**
 *
 * A trava do clube no modo `lote-novo` (`nivel-efetivo.ts`) grava em
 * `playck.prazo` o instante-limite de tudo o que a importação faz sob ela: a
 * espera por travas E as instruções até a última escrita. A matrícula grava
 * 2 s (`PRAZO_DA_MATRICULA_MS`), e a importação usava o mesmo número — com a
 * conexão fria do Prisma 6 (cada texto de SQL novo na conexão custa duas idas:
 * `Parse`/`Describe` e `Execute`), a 167 ms por ida a escrita chegava com 1 ms
 * de prazo, e o arquivo com turma levava `409` sem disputa nenhuma (6 de 6
 * frias, R4 da validação).
 *
 * **Decisão do Israel em 2026-10-28: prazo próprio, ~6 s, no molde da
 * SPEC-086** (`PRAZO_DA_TRAVA_DE_EMAIL_MS` = 2 s + teto de idas × 250 ms).
 * Travas, ordem, regras, mensagens e etapas não mudam; a matrícula continua
 * com 2 s.
 *
 * **Nenhum import do Nest e nenhum alias de caminho**: `nivel-efetivo.ts`, que
 * o seed importa por `ts-node`, importa este arquivo.
 */

/**
 * O teto de instruções que a transação da importação manda ao banco **da
 * trava do clube até o `COMMIT`, inclusive os dois**, no pior caminho (com
 * turma, aula futura, convites e reposição):
 *
 * | # | instrução |
 * |---|---|
 * | 1 | a trava do clube (`lote-novo`, grava o prazo) |
 * | 2 | as referenciadas em `FOR KEY SHARE`, com as contas dos e-mails |
 * | 3 | as turmas em `FOR UPDATE` |
 * | 4 | os dados da conferência de turma (`lerDadosSobATrava`) |
 * | 5–12 | as quatro escritas, cada uma com o ajuste do prazo antes (4 × 2) |
 * | 13 | a reposição do `statement_timeout` |
 * | 14 | o `COMMIT` |
 *
 * O `test/banco/spec-083-importacao.db-spec.ts` CONTA essas instruções no pior
 * caminho, pelo evento `query` do Prisma, e falha se passarem deste número:
 * quem acrescentar uma consulta à transação tem de subir o teto — e, com ele,
 * o prazo. É o que impede o prazo de envelhecer calado.
 */
export const MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO = 14;

/**
 * O custo de uma instrução **fria**: duas idas a 167 ms (o Back em Atlanta, o
 * Neon em São Paulo; medido no proxy da R4) + 1 ms de execução — **335 ms**,
 * o que a R4 mediu por instrução fria (`log-r4headfrio*`, `log-r4prazo4s*`).
 *
 * **A margem não está neste número, está na contagem**, e é declarada: o teto
 * conta como fria toda instrução, inclusive as que não pagam o prazo inteiro —
 * a própria trava (o prazo começa no meio dela), o ajuste das escritas 2 a 4
 * (é o mesmo texto do primeiro, e a conexão já o preparou: uma ida só), a
 * reposição e o `COMMIT` (vêm depois da última escrita, e a reposição devolve
 * o `statement_timeout` da sessão). Medido com a sonda: 4 s de prazo deixaram
 * 1.252 ms na última escrita (sem convites).
 */
export const CUSTO_DA_INSTRUCAO_FRIA_MS = 335;

/** A espera por travas que o prazo admite — a mesma da matrícula e da 086. */
export const ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS = 2_000;

/**
 * O prazo da importação: 2 s de espera + 14 instruções × 335 ms —
 * **6.690 ms**. Gravado em `playck.prazo` pela trava do clube no modo
 * `lote-novo`; todo `lock_timeout` e todo `statement_timeout` de escrita da
 * transação é o que sobra dele (`RESTO_DO_PRAZO`).
 */
export const PRAZO_DA_IMPORTACAO_MS =
  ESPERA_POR_TRAVAS_DA_IMPORTACAO_MS +
  MAX_INSTRUCOES_SOB_A_TRAVA_DA_IMPORTACAO * CUSTO_DA_INSTRUCAO_FRIA_MS;

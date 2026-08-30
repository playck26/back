/**
 * **DEF-020 — "hoje" em SQL, no fuso do clube.**
 *
 * As fixtures usavam `CURRENT_DATE`, que é a data do **servidor Postgres** —
 * e o container roda em UTC, igual à produção. Enquanto o produto também
 * calculava "hoje" em UTC, os dois concordavam e ninguém percebeu.
 *
 * Quando o DEF-020 passou o produto para `America/Sao_Paulo`, **treze provas
 * caíram de uma vez**, com `AULA_FUTURA`: a fixture criava a aula em
 * `CURRENT_DATE` (30 de agosto, em UTC) e o serviço, já correto, via hoje
 * como 29. Eram 21h em Brasília — a janela exata do defeito.
 *
 * Isso não foi um estorvo, foi a **melhor evidência** de que o defeito era
 * real: a suíte reproduziu, sozinha e sem ser pedida, o que o Israel estava
 * vendo no app.
 *
 * A lição é a mesma do produto, e vale para teste igual: **uma convenção,
 * não duas.** Fixture que calcula a data de um jeito e serviço de outro
 * testa a diferença entre os dois, não a regra.
 */
export const HOJE_NO_CLUBE_SQL = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

/** `HOJE_NO_CLUBE_SQL` menos N dias — o mesmo que `CURRENT_DATE - N` fazia. */
export function diasAtrasNoClube(dias: number): string {
  return dias === 0 ? HOJE_NO_CLUBE_SQL : `${HOJE_NO_CLUBE_SQL} - ${dias}`;
}

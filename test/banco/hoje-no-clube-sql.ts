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
export const HOJE_NO_CLUBE_SQL =
  "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

/**
 * **SPEC-027 — e agora a HORA da fixture importa, não só o dia.**
 *
 * A chamada só abre "durante ou depois da aula". Uma fixture que cria a aula
 * **hoje** passa a depender da hora em que a suíte roda: as fixtures deste
 * projeto montam horários como `TIME '00:00' + N*10min`, e às 00:04 da manhã
 * a aula das 00:10 **ainda não começou**.
 *
 * Foi exatamente o que derrubou o CI em 2026-08-30 às 03:03Z — 00:03 em São
 * Paulo. Passava aqui às 22h e falhava lá às 00h, sem uma linha de diferença.
 *
 * **Regra para fixture de aula: use ONTEM (`diasAtrasNoClube(1)`), não hoje.**
 * Ontem já passou inteiro, a qualquer hora, e continua dentro da janela
 * retroativa de 7 dias (INV-017). "Hoje" só serve quando o teste controla o
 * relógio.
 */

/** `HOJE_NO_CLUBE_SQL` menos N dias — o mesmo que `CURRENT_DATE - N` fazia. */
export function diasAtrasNoClube(dias: number): string {
  return dias === 0 ? HOJE_NO_CLUBE_SQL : `${HOJE_NO_CLUBE_SQL} - ${dias}`;
}

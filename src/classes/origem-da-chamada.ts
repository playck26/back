/**
 * SPEC-057/TASK-001/D1 — **as origens possíveis de uma chamada.**
 *
 * A mesma lista mora no CHECK `chamadas_origem_dom_check` (e no
 * `chamadas_origem_inicial_dom_check`), e a db-spec da D1 prova que o banco
 * recusa o que está fora dela. Aqui ela existe uma vez para os DTOs e para o
 * gate DEF-016, que a importam em vez de copiá-la.
 */
export const ORIGENS_DA_CHAMADA = [
  'automatica',
  'professor',
  'gestor',
  'legada_humana',
] as const;

export type OrigemDaChamada = (typeof ORIGENS_DA_CHAMADA)[number];

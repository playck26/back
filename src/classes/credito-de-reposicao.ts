/**
 * SPEC-046/D1 + SPEC-064/LIM-064e — **a regra do crédito de reposição, num
 * lugar só.**
 *
 * ## Por que este arquivo existe
 *
 * O crédito é **derivado** (SPEC-046/D1): não há coluna de saldo, e
 * `crédito = faltas válidas − reposições`. Até a SPEC-064 essa conta estava
 * escrita **duas vezes** dentro de `reposicao.service.ts` — uma em
 * `meuCredito`, para mostrar o saldo, outra em `marcar`, para decidir se a
 * reposição nasce. A SPEC-064 precisa dela uma **terceira** vez, para decidir
 * quem pode entrar na fila de aula (LIM-064e), e três cópias de uma regra
 * derivada é drift garantido.
 *
 * ## E as duas cópias NÃO diziam a mesma coisa
 *
 * Trazê-las para cá tornou visível uma divergência que estava escondida por
 * estarem em funções diferentes do mesmo arquivo:
 *
 * | | `meuCredito` (o saldo na tela) | `marcar` (a reposição de fato) |
 * |---|---|---|
 * | falta expirada | não conta | recusa `SEM_CREDITO_DE_REPOSICAO` |
 * | aula da falta cancelada pelo clube | não conta | recusa `SEM_CREDITO_DE_REPOSICAO` |
 * | **já reposta, em aula que o clube CANCELOU** | **conta de novo** (D7) | **recusa `FALTA_JA_REPOSTA`** |
 *
 * A última linha é uma inconsistência real, e não desta spec: a SPEC-046/D7 diz
 * que *"reposição em aula cancelada não conta, e o crédito volta sozinho"* — e
 * ele volta **na tela**. Mas a linha de `reposicoes_de_aula` continua existindo
 * (só `desmarcar` apaga), a `INV-118` é `UNIQUE (falta_id)`, e `marcar` recusa
 * assim que vê qualquer reposição. **O saldo mostra um crédito que não pode ser
 * gasto.**
 *
 * Corrigir isso é decisão da SPEC-046, não desta — mexer aqui mudaria o saldo
 * exibido a quem já usa o sistema. O que esta spec faz é **não construir em
 * cima do número otimista**: a fila usa `utilizavel`, que é a regra do `marcar`.
 *
 * > **Fila de aula é convite para tentar** (LIM-064a). Convidar alguém com um
 * > crédito que o `marcar` vai recusar é pior que não convidar: ele recebe o
 * > aviso, corre, e leva `409` na cara.
 */

/** O `status_pagamento` que marca ocorrência cancelada pelo clube. */
const CANCELADO = 'cancelado';

/** O mínimo que a regra precisa saber de uma falta. Deliberadamente estrutural
 *  e não o tipo do Prisma: assim a função é testável sem banco. */
export interface FaltaParaCredito {
  ocupacao: { data: Date; statusPagamento: string };
  reposicao: { ocupacao: { statusPagamento: string } } | null;
}

export interface SituacaoDoCredito {
  /** Último dia em que esta falta pode virar reposição. */
  expiraEm: Date;
  expirada: boolean;
  /** O clube cancelou a aula perdida: ele não perdeu nada, não há o que repor. */
  aulaCancelada: boolean;
  /** Reposta **e valendo** — reposição em aula cancelada não conta (D7). */
  reposta: boolean;
  /**
   * O que `meuCredito` soma na tela. **Otimista**: devolve o crédito quando a
   * aula de destino foi cancelada.
   */
  contaComoSaldo: boolean;
  /**
   * O que `marcar` aceita de verdade, e o que a **fila de espera** exige.
   * **Estrito**: qualquer linha de reposição, valendo ou não, bloqueia.
   */
  utilizavel: boolean;
}

/**
 * A data-limite da falta. `UTC` porque `ocupacoes_quadra.data` é `DATE` e o
 * Prisma a entrega à meia-noite UTC — somar dias em fuso local deslocaria o
 * limite num dia para metade do país.
 */
export function expiracaoDoCredito(data: Date, validadeDias: number): Date {
  const expiraEm = new Date(data);
  expiraEm.setUTCDate(expiraEm.getUTCDate() + validadeDias);
  return expiraEm;
}

export function situacaoDoCredito(
  falta: FaltaParaCredito,
  validadeDias: number,
  hoje: Date,
): SituacaoDoCredito {
  const expiraEm = expiracaoDoCredito(falta.ocupacao.data, validadeDias);
  const expirada = expiraEm < hoje;
  const aulaCancelada = falta.ocupacao.statusPagamento === CANCELADO;
  const reposta =
    falta.reposicao !== null &&
    falta.reposicao.ocupacao.statusPagamento !== CANCELADO;

  return {
    expiraEm,
    expirada,
    aulaCancelada,
    reposta,
    contaComoSaldo: !expirada && !aulaCancelada && !reposta,
    utilizavel: !expirada && !aulaCancelada && falta.reposicao === null,
  };
}

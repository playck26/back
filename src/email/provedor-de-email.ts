/**
 * SPEC-083/D8 — MOD-015: **a porta de e-mail, e o vocabulário do resultado.**
 *
 * Duas implementações: a da Resend (produção) e a de memória (teste e
 * desenvolvimento). A porta existe para que quem emite convite (importação,
 * ficha) seja provado sem rede, e para que a Resend fique num arquivo só
 * (INV-083h).
 *
 * **Não há adaptador "log".** Logar o corpo logaria o link, e o link carrega o
 * token que define a senha de alguém (INV-083f).
 */

/**
 * Por que a falha é um destes cinco, e não o erro do provedor: quem grava o
 * resultado no convite (`email_motivo`) e quem mostra a ficha falam a língua
 * da D8, não a da Resend. Traduzir é trabalho do adaptador, que é quem
 * conhece o transporte.
 */
export const MOTIVOS_DA_FALHA = [
  /** O teto diário ou mensal do plano (LIM-083b). O reenvio resolve depois. */
  'cota',
  /** O provedor recusou a mensagem por ser inválida. */
  'recusado',
  /** 5xx, limite por segundo, rede: transitório. */
  'indisponivel',
  /** A chamada passou do tempo máximo. **Pode ter enviado** (LIM-083e). */
  'tempo_esgotado',
  /** Chave inválida ou revogada, domínio não verificado (LIM-083i). */
  'configuracao',
] as const;

export type MotivoDaFalha = (typeof MOTIVOS_DA_FALHA)[number];

export interface MensagemDeEmail {
  /** Já no formato do cabeçalho: `"<clube> via PlayCK" <EMAIL_REMETENTE>`. */
  readonly from: string;
  /** Um destinatário por mensagem: o convite é pessoal. */
  readonly to: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /**
   * A identidade da mensagem, e por isso a chave de idempotência do envio
   * avulso: `convite-de-acesso/<id do convite>`. No lote, a chave do bloco é
   * o sha256 destas chaves, ou seja, dos ids do bloco (D8).
   */
  readonly chaveDeIdempotencia: string;
}

/**
 * **Uma resposta por mensagem, na ordem em que entraram.** "Aceito" quer dizer
 * aceito pelo provedor, e não entregue (LIM-083a).
 */
export type ResultadoDoEnvio =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly motivo: MotivoDaFalha };

export interface ProvedorDeEmail {
  /**
   * **Nunca lança.** Falha é resultado: o convite já foi gravado quando o
   * envio acontece (depois do commit, D8), e uma exceção aqui viraria `500`
   * para uma importação que deu certo.
   */
  enviar(mensagem: MensagemDeEmail): Promise<ResultadoDoEnvio>;
  /**
   * Partido em blocos de {@link TAMANHO_DO_BLOCO}, uma chamada por bloco. Se o
   * provedor recusa um bloco inteiro, todas as mensagens dele saem com o
   * mesmo motivo. Também nunca lança.
   */
  enviarLote(
    mensagens: readonly MensagemDeEmail[],
  ): Promise<ResultadoDoEnvio[]>;
}

/** Token de injeção — a implementação é escolhida no módulo, pela configuração. */
export const PROVEDOR_DE_EMAIL = Symbol('PROVEDOR_DE_EMAIL');

/** O teto do envio em lote da Resend (State 14 da SPEC-083). */
export const TAMANHO_DO_BLOCO = 100;

/**
 * Compartilhada pelos dois adaptadores de propósito: o de memória registra os
 * blocos como o da Resend os chamaria, e é assim que um teste com o provedor
 * memória enxerga "150 convidados, duas chamadas" (AC-032).
 */
export function partirEmBlocos<T>(itens: readonly T[]): T[][] {
  const blocos: T[][] = [];
  for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_DO_BLOCO) {
    blocos.push(itens.slice(inicio, inicio + TAMANHO_DO_BLOCO));
  }
  return blocos;
}

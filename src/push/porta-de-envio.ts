/**
 * SPEC-062/D1a — **a porta de envio, e o vocabulário do contrato operacional.**
 *
 * Duas implementações: o adaptador `web-push` (produção) e o de memória (teste
 * e ambiente sem par VAPID). A porta existe para que o tick — que é onde mora
 * a concorrência — possa ser provado sem rede.
 */

/** O destino, do jeito que o navegador o emite. Os três campos são CREDENCIAL. */
export interface DestinoDePush {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface AvisoParaEnviar {
  readonly titulo: string;
  readonly corpo: string;
  readonly destinoUrl: string | null;
  /** Segundos. Já calculado pelo tick a partir de `expira_em` (D1a). */
  readonly ttl: number;
}

/**
 * O que o envio devolve, na linguagem da D1a — **não em HTTP**.
 *
 * O tick decide transição por AQUI, e não por código de status: quem traduz
 * status é o adaptador, que é quem conhece o transporte. Foi essa fronteira
 * que permitiu provar as seis transições sem rede.
 */
export type ResultadoDeEnvio =
  /** `201`/`202` — o serviço de push aceitou. Não é entrega, é aceitação. */
  | { readonly tipo: 'aceito' }
  /** `410`, e `404` quando o serviço documenta ausência de inscrição. */
  | { readonly tipo: 'assinatura_morta'; readonly status: number }
  /** `429`/`5xx`/socket. `esperaSugeridaSegundos` vem do `Retry-After`. */
  | {
      readonly tipo: 'temporario';
      readonly status: number | null;
      readonly esperaSugeridaSegundos: number | null;
      readonly detalhe: string;
    }
  /**
   * `400`/`403`/`413` e o corpo cifrado acima do teto: **nosso erro**. Sem
   * retentativa — repetir o que o servidor já recusou por ser inválido só
   * gasta o serviço de push e atrasa aviso de verdade.
   */
  | {
      readonly tipo: 'falha_operacional';
      readonly status: number | null;
      readonly detalhe: string;
    };

export interface PortaDeEnvio {
  /**
   * Envia UM aviso para UM destino. Nunca lança por falha de envio: falha é
   * resultado, e o tick precisa dela para escolher a transição.
   */
  enviar(
    destino: DestinoDePush,
    aviso: AvisoParaEnviar,
  ): Promise<ResultadoDeEnvio>;
}

/** Token de injeção — a implementação é escolhida no módulo, pelo ambiente. */
export const PORTA_DE_ENVIO = Symbol('PORTA_DE_ENVIO');

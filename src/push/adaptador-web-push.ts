import { Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { impressaoDaAssinatura } from './impressao-da-assinatura';
import type {
  AvisoParaEnviar,
  DestinoDePush,
  PortaDeEnvio,
  ResultadoDeEnvio,
} from './porta-de-envio';
import type { ConfiguracaoVapid } from './vapid.config';

/** SPEC-062/D1a — teto do corpo **cifrado**, não do texto puro. */
export const TETO_DO_CORPO_CIFRADO = 3 * 1024;

/**
 * D4a — `timeout` do `web-push` é **inatividade de socket**, não duração.
 *
 * Isto derrubou a v4 da SPEC-061: a versão anterior provava um teto de lote
 * por aritmética em cima deste número, e ele não mede o que ela supunha. Ele
 * resolve o socket parado, que é o caso comum, e a spec parou de fingir que
 * resolve o resto — `sendNotification` não aceita `signal`, e `Promise.race`
 * não cancela a requisição.
 */
export const TIMEOUT_DE_SOCKET_MS = 5_000;

/**
 * SPEC-062/D1a — o adaptador de produção.
 *
 * **Não é injetável por decorator**: ele nasce da configuração VAPID, que pode
 * não existir, e quem decide isso é o módulo. Sem par, nem se constrói.
 */
export class AdaptadorWebPush implements PortaDeEnvio {
  private readonly logger = new Logger(AdaptadorWebPush.name);

  constructor(private readonly vapid: ConfiguracaoVapid) {}

  async enviar(
    destino: DestinoDePush,
    aviso: AvisoParaEnviar,
  ): Promise<ResultadoDeEnvio> {
    const corpo = JSON.stringify({
      titulo: aviso.titulo,
      corpo: aviso.corpo,
      destinoUrl: aviso.destinoUrl,
    });

    // D1a — **medir DEPOIS da cifra.** O texto puro cabe e o cifrado não: a
    // `aes128gcm` acrescenta salt, chave pública efêmera e padding, e o teto
    // que o serviço de push aplica é sobre o que trafega. Medir o texto puro
    // seria medir a coisa errada e descobrir em produção, com `413`.
    let cifrado: Buffer;
    try {
      cifrado = webpush.encrypt(
        destino.p256dh,
        destino.auth,
        corpo,
        'aes128gcm',
      ).cipherText;
    } catch (causa) {
      return {
        tipo: 'falha_operacional',
        status: null,
        detalhe: `cifra falhou: ${nomeDoErro(causa)}`,
      };
    }

    if (cifrado.length > TETO_DO_CORPO_CIFRADO) {
      // Recusa ANTES de enviar (AC-010). Enviar para receber `413` gastaria
      // uma ida ao serviço de push para aprender o que já se sabia aqui.
      return {
        tipo: 'falha_operacional',
        status: null,
        detalhe: `corpo cifrado de ${cifrado.length} bytes acima do teto`,
      };
    }

    try {
      await webpush.sendNotification(
        {
          endpoint: destino.endpoint,
          keys: { p256dh: destino.p256dh, auth: destino.auth },
        },
        corpo,
        {
          TTL: aviso.ttl,
          contentEncoding: 'aes128gcm',
          timeout: TIMEOUT_DE_SOCKET_MS,
          vapidDetails: {
            subject: this.vapid.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
        },
      );
      return { tipo: 'aceito' };
    } catch (causa) {
      return this.traduzir(causa, destino);
    }
  }

  /**
   * D1a — a tabela de respostas, e ela tem uma sutileza que custou uma rodada
   * de validação: **`404` não é sinônimo de `410`.**
   *
   * `410` é "esta assinatura expirou" e manda apagar. `404` também pode ser
   * caminho inválido — ou seja, **integração quebrada** —, e apagar a
   * assinatura de todo mundo nesse caso mascararia o defeito, silenciosamente,
   * um aparelho por vez. Por isso `404` só apaga quando o corpo da resposta diz
   * que a inscrição não existe; o resto é `falha_operacional` com alerta.
   */
  private traduzir(causa: unknown, destino: DestinoDePush): ResultadoDeEnvio {
    if (!(causa instanceof webpush.WebPushError)) {
      // Socket parado, DNS, rede: temporário. O tick reagenda com espera
      // crescente.
      return {
        tipo: 'temporario',
        status: null,
        esperaSugeridaSegundos: null,
        detalhe: nomeDoErro(causa),
      };
    }

    const status = causa.statusCode;
    const impressao = impressaoDaAssinatura(destino.endpoint);

    if (status === 410 || (status === 404 && inscricaoAusente(causa.body))) {
      return { tipo: 'assinatura_morta', status };
    }

    if (status === 404) {
      // INV-062f — a impressão, nunca o `endpoint`.
      this.logger.error({
        evento: 'push_404_sem_inscricao_ausente',
        assinatura: impressao,
        detalhe: 'pode ser integração quebrada; assinatura NÃO apagada',
      });
      return {
        tipo: 'falha_operacional',
        status,
        detalhe: '404 sem indicação de inscrição ausente',
      };
    }

    if (status === 400 || status === 403 || status === 413) {
      this.logger.error({
        evento: 'push_falha_operacional',
        status,
        assinatura: impressao,
      });
      return { tipo: 'falha_operacional', status, detalhe: `HTTP ${status}` };
    }

    if (status === 429 || status >= 500) {
      return {
        tipo: 'temporario',
        status,
        esperaSugeridaSegundos: retryAfterEmSegundos(causa.headers),
        detalhe: `HTTP ${status}`,
      };
    }

    // Status que a D1a não previu. Temporário é a escolha conservadora: ele
    // termina sozinho em três tentativas, e `falha_operacional` esconderia um
    // caso novo atrás de um estado que ninguém investiga.
    return {
      tipo: 'temporario',
      status,
      esperaSugeridaSegundos: retryAfterEmSegundos(causa.headers),
      detalhe: `HTTP ${status} (não previsto na D1a)`,
    };
  }
}

/**
 * `Retry-After` vem em segundos ou como data HTTP. Valor inválido vira `null`,
 * e o tick usa a espera crescente — nunca menos do que o serviço pediu (D4b).
 */
export function retryAfterEmSegundos(
  headers: Record<string, string> | undefined,
): number | null {
  const bruto = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!bruto) {
    return null;
  }
  const segundos = Number(bruto);
  if (Number.isFinite(segundos) && segundos >= 0) {
    return Math.ceil(segundos);
  }
  const data = Date.parse(bruto);
  if (Number.isNaN(data)) {
    return null;
  }
  return Math.max(0, Math.ceil((data - Date.now()) / 1000));
}

/**
 * Os serviços de push divergem no texto, e nenhum promete estabilidade. Por
 * isso a conferência é conservadora: **na dúvida, NÃO apaga** — perder a
 * assinatura de quem ainda a tem é pior que manter uma morta, que o próximo
 * envio derruba com `410`.
 */
function inscricaoAusente(corpo: string | undefined): boolean {
  if (!corpo) {
    return false;
  }
  const texto = corpo.toLowerCase();
  return (
    texto.includes('unsubscribed') ||
    texto.includes('expired') ||
    texto.includes('no such subscription') ||
    texto.includes('subscription not found')
  );
}

function nomeDoErro(causa: unknown): string {
  return causa instanceof Error ? causa.name : 'desconhecido';
}

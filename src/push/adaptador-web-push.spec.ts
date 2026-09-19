import { WebPushError } from 'web-push';
import {
  AdaptadorWebPush,
  retryAfterEmSegundos,
  TETO_DO_CORPO_CIFRADO,
} from './adaptador-web-push';
import type { DestinoDePush, ResultadoDeEnvio } from './porta-de-envio';
import type { ConfiguracaoVapid } from './vapid.config';

/**
 * SPEC-062/D1a — **a tabela de respostas, e a sutileza que custou uma rodada.**
 *
 * Estes testes chamam o tradutor direto, sem rede: o que se julga aqui é a
 * decisão, não o transporte. `traduzir` é privado de propósito — o teste o
 * alcança pelo protótipo, e isso é intencional: expor o método só para testar
 * convidaria alguém a chamá-lo de fora, e a fronteira da porta deixaria de
 * existir.
 */
const VAPID: ConfiguracaoVapid = {
  publicKey: 'publica-de-teste',
  privateKey: 'privada-de-teste',
  subject: 'mailto:suporte@ent.app.br',
  impressaoDaPrivada: 'x'.repeat(64),
};

const DESTINO: DestinoDePush = {
  endpoint: 'https://push.exemplo/abc',
  p256dh: 'p',
  auth: 'a',
};

function traduzir(causa: unknown): ResultadoDeEnvio {
  const adaptador = new AdaptadorWebPush(VAPID) as unknown as {
    traduzir(c: unknown, d: DestinoDePush): ResultadoDeEnvio;
  };
  return adaptador.traduzir(causa, DESTINO);
}

function erroHttp(status: number, corpo = '', headers = {}): WebPushError {
  return new WebPushError('falhou', status, headers, corpo, DESTINO.endpoint);
}

describe('AdaptadorWebPush — a tradução da D1a', () => {
  it('410 mata a assinatura', () => {
    expect(traduzir(erroHttp(410))).toEqual({
      tipo: 'assinatura_morta',
      status: 410,
    });
  });

  it('404 COM indicação de inscrição ausente mata a assinatura', () => {
    expect(
      traduzir(erroHttp(404, 'push subscription has unsubscribed')),
    ).toEqual({ tipo: 'assinatura_morta', status: 404 });
  });

  it('404 SEM indicação NÃO mata a assinatura', () => {
    // **A sutileza inteira.** `404` também é sintoma de integração quebrada —
    // caminho errado, serviço trocado. Apagar a assinatura aqui esconderia o
    // defeito em silêncio, um aparelho por vez, e ninguém investigaria: cada
    // pessoa simplesmente pararia de receber.
    const r = traduzir(erroHttp(404, 'not found'));
    expect(r.tipo).toBe('falha_operacional');
  });

  it.each([400, 403, 413])('%i é NOSSO erro, sem retentativa', (status) => {
    expect(traduzir(erroHttp(status)).tipo).toBe('falha_operacional');
  });

  it.each([429, 500, 503])('%i é temporário', (status) => {
    expect(traduzir(erroHttp(status)).tipo).toBe('temporario');
  });

  it('429 carrega o Retry-After que o serviço pediu', () => {
    const r = traduzir(erroHttp(429, '', { 'retry-after': '120' }));
    expect(r).toMatchObject({
      tipo: 'temporario',
      esperaSugeridaSegundos: 120,
    });
  });

  it('status não previsto vira temporário, não falha operacional', () => {
    // Conservador de propósito: temporário termina sozinho em três
    // tentativas. `falha_operacional` esconderia um caso novo atrás de um
    // estado terminal que ninguém investiga.
    expect(traduzir(erroHttp(418)).tipo).toBe('temporario');
  });

  it('erro que não é do web-push (socket, DNS) é temporário', () => {
    expect(traduzir(new Error('ECONNRESET'))).toMatchObject({
      tipo: 'temporario',
      status: null,
    });
  });
});

describe('retryAfterEmSegundos', () => {
  it('lê segundos', () => {
    expect(retryAfterEmSegundos({ 'retry-after': '90' })).toBe(90);
  });

  it('lê data HTTP', () => {
    const daqui = new Date(Date.now() + 60_000).toUTCString();
    const lido = retryAfterEmSegundos({ 'retry-after': daqui });
    expect(lido).toBeGreaterThan(50);
    expect(lido).toBeLessThanOrEqual(61);
  });

  it('ausente ou inválido é null, e aí vale a espera crescente', () => {
    expect(retryAfterEmSegundos(undefined)).toBeNull();
    expect(retryAfterEmSegundos({ 'retry-after': 'amanhã' })).toBeNull();
  });
});

describe('AC-010 — o teto é do corpo CIFRADO', () => {
  it('recusa antes de enviar, sem tocar na rede', async () => {
    // Cifra devolvendo um buffer acima do teto: o adaptador tem de parar
    // AQUI. Enviar para receber `413` gastaria uma ida ao serviço de push
    // para aprender o que já se sabia.
    const webpush: { encrypt: jest.Mock; sendNotification: jest.Mock } =
      jest.requireMock('web-push');
    webpush.encrypt.mockReturnValue({
      cipherText: Buffer.alloc(TETO_DO_CORPO_CIFRADO + 1),
    });

    const r = await new AdaptadorWebPush(VAPID).enviar(DESTINO, {
      titulo: 't',
      corpo: 'c',
      destinoUrl: null,
      ttl: 60,
    });

    expect(r.tipo).toBe('falha_operacional');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

jest.mock('web-push', () => {
  const real: Record<string, unknown> = jest.requireActual('web-push');
  return {
    ...real,
    encrypt: jest.fn(),
    sendNotification: jest.fn(),
  };
});

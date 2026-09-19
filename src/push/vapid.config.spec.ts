import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { impressaoDaAssinatura } from './impressao-da-assinatura';
import {
  lerEstadoDoVapid,
  PAPEIS_VAPID,
  registrarEstadoNoBoot,
} from './vapid.config';

function configCom(valores: Record<string, string>): ConfigService {
  return {
    get: <T>(chave: string): T | undefined => valores[chave] as T | undefined,
  } as unknown as ConfigService;
}

const PAR = {
  PUSH_VAPID_PUBLIC_KEY: 'BN4GvZtEZiZuqFxSNVtDS',
  PUSH_VAPID_PRIVATE_KEY: 'kYiFBZ5uvQ2mXnR7tLpA4wCeDfGhJkMnBvCxZaSdF3',
  PUSH_VAPID_SUBJECT: 'mailto:suporte@ent.app.br',
};

describe('lerEstadoDoVapid — falha fechada (D1b, AC-009)', () => {
  it('com as três, devolve configuração', () => {
    const estado = lerEstadoDoVapid(configCom(PAR));
    expect(estado.faltando).toEqual([]);
    expect(estado.configuracao?.publicKey).toBe(PAR.PUSH_VAPID_PUBLIC_KEY);
  });

  it.each(PAPEIS_VAPID)(
    'faltando %s, nasce desligado e NOMEIA a que falta',
    (papel) => {
      const parcial = { ...PAR };
      delete (parcial as Record<string, string>)[papel];

      const estado = lerEstadoDoVapid(configCom(parcial));

      expect(estado.configuracao).toBeNull();
      expect(estado.faltando).toEqual([papel]);
    },
  );

  it('valor só com espaço conta como ausente', () => {
    // Variável criada e deixada vazia é o erro de operação mais comum, e a
    // que mais engana: ela EXISTE. Se passasse, o erro só apareceria no
    // primeiro envio, longe da causa.
    const estado = lerEstadoDoVapid(
      configCom({ ...PAR, PUSH_VAPID_SUBJECT: '   ' }),
    );
    expect(estado.configuracao).toBeNull();
    expect(estado.faltando).toEqual(['PUSH_VAPID_SUBJECT']);
  });

  it('a impressão é o sha256 do TEXTO da privada', () => {
    // É o insumo do gate G7, que procura a chave no bundle publicado. Se a
    // impressão fosse de outra coisa — do par, do público —, o gate
    // procuraria um valor que nunca esteve lá e passaria sempre.
    const estado = lerEstadoDoVapid(configCom(PAR));
    expect(estado.configuracao?.impressaoDaPrivada).toBe(
      createHash('sha256').update(PAR.PUSH_VAPID_PRIVATE_KEY).digest('hex'),
    );
  });
});

describe('registrarEstadoNoBoot — D1c/1, nomes e nunca valores', () => {
  it('nomeia as que faltam, em nível error', () => {
    const logger = { error: jest.fn(), log: jest.fn() } as unknown as Logger;

    registrarEstadoNoBoot(
      { configuracao: null, faltando: ['PUSH_VAPID_PRIVATE_KEY'] },
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith(
      'push desligado: faltam PUSH_VAPID_PRIVATE_KEY',
    );
  });

  it('NUNCA imprime valor, nem fragmento dele', () => {
    // O log é o lugar mais fácil de vazar segredo, e mascarar ("BN4x…") já
    // vazaria tamanho e alfabeto.
    const logger = { error: jest.fn(), log: jest.fn() } as unknown as Logger;
    const estado = lerEstadoDoVapid(configCom(PAR));

    registrarEstadoNoBoot(estado, logger);

    const escrito = JSON.stringify(
      (logger.log as jest.Mock).mock.calls.concat(
        (logger.error as jest.Mock).mock.calls,
      ),
    );
    expect(escrito).not.toContain(PAR.PUSH_VAPID_PRIVATE_KEY);
    expect(escrito).not.toContain(PAR.PUSH_VAPID_PRIVATE_KEY.slice(0, 6));
  });
});

describe('impressaoDaAssinatura — INV-062f', () => {
  it('oito caracteres, estáveis, e nada do endpoint', () => {
    const endpoint = 'https://push.exemplo/uma-assinatura-secreta';
    const impressao = impressaoDaAssinatura(endpoint);

    expect(impressao).toHaveLength(8);
    expect(impressao).toBe(impressaoDaAssinatura(endpoint));
    expect(endpoint).not.toContain(impressao);
  });

  it('endpoints diferentes, impressões diferentes', () => {
    expect(impressaoDaAssinatura('https://a/1')).not.toBe(
      impressaoDaAssinatura('https://a/2'),
    );
  });
});

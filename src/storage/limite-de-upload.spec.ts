import { HttpException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ContagemPorIp } from '../common/throttle/contagem-por-ip';
import {
  JANELA_DE_UPLOAD_MS,
  LIMITE_DE_UPLOADS,
  REQUISICOES_DEMAIS,
  ThrottlerPorUsuario,
} from './limite-de-upload';

// SPEC-017/TASK-006 — NFR-004.
//
// **O que está em jogo não é o nosso bucket.** A assinatura do Spaces é por
// CONTA (ADR-015), e o `opinii-media` divide a mesma cota: abuso de um
// tenant daqui estoura o produto do lado, que não tem como se defender.
//
// ---
//
// **Estes testes usam `JwtService` de verdade, não dublê.** A 3ª validação
// cruzada derrubou a versão anterior porque ela lia `request.user`, que não
// existe quando o guard global roda — e o unitário passava, porque o dublê
// entregava o usuário que a produção nunca entregou. Dublê que responde o
// que o teste quer não prova nada sobre o que o servidor faz.

const SEGREDO = 'segredo-de-teste-nao-usado-em-lugar-nenhum';
const OUTRO_SEGREDO = 'segredo-do-atacante';

const jwt = new JwtService({});

function guardCom(config: ConfigService): ThrottlerPorUsuario {
  // `Reflector` de verdade: é ele que lê a marca `@ContagemPorIp()`, e um
  // dublê aqui provaria a leitura que o teste inventou, não a do Nest.
  return new ThrottlerPorUsuario(
    {} as never,
    {} as never,
    new Reflector(),
    jwt,
    config,
  );
}

function guard(): ThrottlerPorUsuario {
  return guardCom(new ConfigService({ JWT_ACCESS_SECRET: SEGREDO }));
}

/** `ConfigService` cai para `process.env` quando não acha a chave, então o
 *  "sem segredo" precisa ser um dublê que recusa de verdade. */
function guardSemSegredo(): ThrottlerPorUsuario {
  return guardCom({ get: () => undefined } as unknown as ConfigService);
}

function req(dados: {
  authorization?: string;
  ip?: string;
  user?: { sub: string };
}): Request {
  const { authorization, ...resto } = dados;
  return {
    ...resto,
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
}

function bearer(
  payload: Record<string, unknown>,
  opcoes: { secret?: string; expiresIn?: number } = {},
): string {
  return `Bearer ${jwt.sign(payload, {
    secret: opcoes.secret ?? SEGREDO,
    ...(opcoes.expiresIn === undefined ? {} : { expiresIn: opcoes.expiresIn }),
  })}`;
}

/** Rota comum, sem marca nenhuma. */
class RotaQualquer {
  handler() {}
}

/** Rota de força bruta, como `/auth/login`. */
class RotaPorIp {
  @ContagemPorIp()
  handler() {}
}

/**
 * Contexto como o Nest entrega: o guard lê a marca do **handler** e da
 * classe. Um contexto ausente é caso próprio, testado à parte.
 */
function contextoDe(alvo: { new (): { handler(): void } }): ExecutionContext {
  return {
    getHandler: () => alvo.prototype.handler,
    getClass: () => alvo,
  } as unknown as ExecutionContext;
}

/** `getTracker` é `protected` — o teste precisa do mesmo acesso do Nest. */
function chamarGetTracker(
  g: ThrottlerPorUsuario,
  r: Request,
  contexto: ExecutionContext | undefined,
): Promise<string> {
  return (
    g as unknown as {
      getTracker(r: Request, c?: ExecutionContext): Promise<string>;
    }
  ).getTracker(r, contexto);
}

function tracker(
  g: ThrottlerPorUsuario,
  r: Request,
  contexto: ExecutionContext = contextoDe(RotaQualquer),
): Promise<string> {
  return chamarGetTracker(g, r, contexto);
}

/**
 * Helper separado, e de propósito: **valor padrão de parâmetro captura o
 * `undefined` explícito**, então `tracker(g, r, undefined)` usaria o padrão
 * e provaria o contrário do que diz. Tropecei nisso duas vezes nesta spec.
 */
function trackerSemContexto(
  g: ThrottlerPorUsuario,
  r: Request,
): Promise<string> {
  return chamarGetTracker(g, r, undefined);
}

describe('ThrottlerPorUsuario', () => {
  describe('a identidade vem do token CONFERIDO', () => {
    it('token válido conta por USUÁRIO', async () => {
      // Por IP seria errado nos dois sentidos: o wi-fi do clube faria um
      // gestor legítimo bater no teto do colega, e um abusador com IP
      // rotativo passaria batido. Era assim que o projeto contava.
      await expect(
        tracker(
          guard(),
          req({ authorization: bearer({ sub: 'u-123' }), ip: '10.0.0.1' }),
        ),
      ).resolves.toBe('usuario:u-123');
    });

    it('token FORJADO cai para o IP — é a prova que mais importa', async () => {
      // Se bastasse `decode`, um atacante trocaria o `sub` a cada
      // requisição e teria baldes infinitos: PIOR que contar por IP, não
      // melhor. O token abaixo é bem formado e tem `sub` — só está assinado
      // com outra chave.
      await expect(
        tracker(
          guard(),
          req({
            authorization: bearer({ sub: 'vitima' }, { secret: OUTRO_SEGREDO }),
            ip: '10.0.0.1',
          }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('token EXPIRADO cai para o IP', async () => {
      await expect(
        tracker(
          guard(),
          req({
            authorization: bearer({ sub: 'u-123' }, { expiresIn: -60 }),
            ip: '10.0.0.1',
          }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('token com `alg: none` cai para o IP', async () => {
      // A forma clássica de furar quem só olha o payload. Não é ataque de
      // confusão de algoritmo (o projeto usa segredo simétrico, então não
      // há chave pública para usar como HMAC) — é mais simples que isso:
      // um token sem assinatura nenhuma, dizendo que não precisa de uma.
      const base64url = (o: unknown): string =>
        Buffer.from(JSON.stringify(o))
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const semAssinatura = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(
        { sub: 'vitima' },
      )}.`;

      await expect(
        tracker(
          guard(),
          req({ authorization: `Bearer ${semAssinatura}`, ip: '10.0.0.1' }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('token válido SEM `sub` cai para o IP', async () => {
      await expect(
        tracker(
          guard(),
          req({ authorization: bearer({ email: 'x@y.z' }), ip: '10.0.0.1' }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('rota marcada com `@ContagemPorIp()` conta por IP mesmo com token bom', async () => {
      // `/auth/login` e companhia. Este produto tem auto-cadastro: se o
      // token comprasse um balde, o teto de 10 tentativas viraria "10 vezes
      // o número de contas que o atacante criar".
      await expect(
        tracker(
          guard(),
          req({ authorization: bearer({ sub: 'u-123' }), ip: '10.0.0.1' }),
          contextoDe(RotaPorIp),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('SEM contexto, o piso é o IP — na dúvida, o limite mais estreito', async () => {
      // Só acontece se alguém chamar `getTracker` fora do guard. O default
      // oposto deixaria uma rota de login contando por usuário sem ninguém
      // notar, e é exatamente esse tipo de silêncio que custou um deploy
      // nesta spec.
      await expect(
        trackerSemContexto(
          guard(),
          req({ authorization: bearer({ sub: 'u-123' }), ip: '10.0.0.1' }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('`request.user` NÃO é fonte de identidade', async () => {
      // O guard global roda antes do `JwtAuthGuard`, então em produção isto
      // é sempre `undefined`. O teste existe para que ninguém "conserte" o
      // guard voltando a ler daqui: seria ramo morto que passa no unitário
      // e nunca roda no servidor. Foi assim que o defeito se escondeu.
      await expect(
        tracker(guard(), req({ user: { sub: 'u-999' }, ip: '10.0.0.1' })),
      ).resolves.toBe('ip:10.0.0.1');
    });
  });

  describe('o piso é o IP', () => {
    it('sem header, conta por IP', async () => {
      await expect(tracker(guard(), req({ ip: '10.0.0.1' }))).resolves.toBe(
        'ip:10.0.0.1',
      );
    });

    it.each([
      ['esquema errado', 'Basic YWJjOmRlZg=='],
      ['sem esquema', 'abc.def.ghi'],
      ['Bearer vazio', 'Bearer '],
      ['Bearer com lixo', 'Bearer nao-e-um-jwt'],
    ])('header %s cai para o IP', async (_nome, authorization) => {
      await expect(
        tracker(guard(), req({ authorization, ip: '10.0.0.1' })),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('sem segredo configurado, degrada para IP em vez de derrubar', async () => {
      // O app não sobe sem `JWT_ACCESS_SECRET`. Mas um guard que estoura
      // aqui derrubaria TODA requisição por causa do limite de abuso — a
      // falha certa neste ponto é contar por IP.
      await expect(
        tracker(
          guardSemSegredo(),
          req({ authorization: bearer({ sub: 'u-123' }), ip: '10.0.0.1' }),
        ),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('sem usuário e sem IP, ainda devolve uma chave', async () => {
      // Chave vazia colapsaria todo mundo num balde só, e o primeiro
      // abusador derrubaria o acesso de todos.
      await expect(tracker(guard(), req({}))).resolves.toBe('ip:desconhecido');
    });
  });

  it('usuário e IP nunca colidem — as chaves são prefixadas', async () => {
    const porUsuario = await tracker(
      guard(),
      req({ authorization: bearer({ sub: 'x' }) }),
    );
    const porIp = await tracker(guard(), req({ ip: 'x' }));
    expect(porUsuario).not.toBe(porIp);
  });

  it('o 429 traz `code` estável', () => {
    // Convenção do projeto para erro de domínio. Frontend que decide por
    // string de mensagem quebra na primeira revisão de texto.
    let erro: unknown;
    try {
      (
        guard() as unknown as { throwThrottlingException(): void }
      ).throwThrottlingException();
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(HttpException);
    expect((erro as HttpException).getStatus()).toBe(429);
    expect((erro as HttpException).getResponse()).toMatchObject({
      code: 'REQUISICOES_DEMAIS',
    });
  });

  it('30 envios por hora — números congelados', () => {
    // O número sai do uso real: um gestor trocando a imagem de dez quadras,
    // errando e repetindo, fica bem abaixo de 30. E retry é ESPERADO — a
    // foto é tirada na quadra, com o sinal ruim que a SPEC-014 documenta.
    expect(LIMITE_DE_UPLOADS).toBe(30);
    expect(JANELA_DE_UPLOAD_MS).toBe(60 * 60 * 1000);
    expect(REQUISICOES_DEMAIS.statusCode).toBe(429);
  });
});

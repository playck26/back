import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
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

function guard(): ThrottlerPorUsuario {
  return new ThrottlerPorUsuario({} as never, {} as never, {} as never);
}

function req(dados: { user?: { sub: string }; ip?: string }): Request {
  return dados as unknown as Request;
}

/** `getTracker` é `protected` — o teste precisa do mesmo acesso do Nest. */
function tracker(g: ThrottlerPorUsuario, r: Request): Promise<string> {
  return (
    g as unknown as { getTracker(r: Request): Promise<string> }
  ).getTracker(r);
}

describe('ThrottlerPorUsuario', () => {
  it('conta por USUÁRIO quando há um', async () => {
    // Por IP seria errado nos dois sentidos: o wi-fi do clube faria um
    // gestor legítimo bater no teto do colega, e um abusador com IP
    // rotativo passaria batido. Era assim que o projeto contava até hoje.
    await expect(
      tracker(guard(), req({ user: { sub: 'u-123' }, ip: '10.0.0.1' })),
    ).resolves.toBe('usuario:u-123');
  });

  it('cai para o IP quando não há usuário', async () => {
    // Rota pública não tem quem identificar, e o IP é o que sobra.
    await expect(tracker(guard(), req({ ip: '10.0.0.1' }))).resolves.toBe(
      'ip:10.0.0.1',
    );
  });

  it('sem usuário e sem IP, ainda devolve uma chave', async () => {
    // Chave vazia colapsaria todo mundo num balde só, e o primeiro abusador
    // derrubaria o acesso de todos.
    await expect(tracker(guard(), req({}))).resolves.toBe('ip:desconhecido');
  });

  it('usuário e IP nunca colidem — as chaves são prefixadas', async () => {
    const porUsuario = await tracker(guard(), req({ user: { sub: 'x' } }));
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

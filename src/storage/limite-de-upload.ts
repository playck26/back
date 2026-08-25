import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  getOptionsToken,
  getStorageToken,
  Throttle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-017/TASK-006 — NFR-004, o limite de abuso do upload.
 *
 * **O que está em jogo não é o nosso bucket.** A assinatura do Spaces é por
 * **conta**: 250 GB e 1 TB de tráfego somados, e o `opinii-media` divide a
 * mesma cota (ADR-015). Abuso de um tenant daqui não estoura o PlayCK —
 * estoura o produto do lado, que não tem nada a ver com isso e não tem como
 * se defender.
 *
 * ---
 *
 * **Um guard só, e ele é o global.** A primeira versão somava um segundo
 * guard na rota, e não funcionou: guard global roda **antes** do guard de
 * rota, os dois liam o mesmo `@Throttle(...)`, batiam no limite na mesma
 * requisição, e o global respondia primeiro — com o 429 genérico, sem o
 * `code`. Tentar tirar o global do caminho com `@SkipThrottle()` desligou os
 * **dois**, porque a marca é lida por throttler nomeado e vale para todos.
 * Medido nos dois casos, não deduzido.
 *
 * A saída foi trocar o guard global por este. Sai mais simples e resolve um
 * problema que já existia: **o throttle do projeto era por IP**, e IP é a
 * chave errada para um clube — o wi-fi compartilhado faria um gestor bater
 * no teto do colega, e um abusador com IP rotativo passaria batido.
 *
 * ---
 *
 * ## Por que este guard confere o token ele mesmo (3ª validação cruzada)
 *
 * A primeira versão lia `request.user.sub`. **Não funcionava, e a revisão
 * externa pegou:** `APP_GUARD` roda **antes** do `JwtAuthGuard` de rota, e
 * naquele instante `request.user` ainda não existe. Toda rota autenticada
 * caía silenciosamente no IP — exatamente o comportamento que este guard
 * existia para substituir.
 *
 * O mais caro não foi o defeito: foi que **três documentos afirmavam
 * "conta por usuário"** enquanto a produção contava por IP. A armadilha
 * estava escrita, por mim, no cabeçalho do próprio `JwtAuthGuard`.
 *
 * Por isso a identidade sai de uma fonte só — o **Bearer token conferido
 * aqui** — e não de `request.user`. Duas razões:
 *
 * 1. **Não depende de ordem de guard.** Era a ordem que estava errada.
 * 2. **Não deixa ramo morto.** Ler `request.user` continuaria compilando,
 *    continuaria passando no unitário e nunca rodaria em produção. Foi assim
 *    que o defeito se escondeu por um deploy inteiro.
 *
 * **É `verify`, nunca `decode`.** Um `sub` não conferido é escolhido pelo
 * atacante: bastaria trocar o `sub` a cada requisição para ter baldes
 * infinitos — **pior que contar por IP**, não melhor. Token inválido,
 * expirado ou ausente cai no IP, que é o piso correto para quem não provou
 * quem é.
 */

/**
 * 30 uploads por hora, por usuário e por rota.
 *
 * O número sai do uso real e do que a SPEC-014 já documenta: a foto é tirada
 * na quadra, com sinal ruim, e **retry é esperado, não excepcional**. Um
 * gestor trocando a imagem de dez quadras, errando e repetindo, fica bem
 * abaixo de 30. Quem passa disso numa hora não está usando o produto.
 */
export const LIMITE_DE_UPLOADS = 30;
export const JANELA_DE_UPLOAD_MS = 60 * 60 * 1000;

export const REQUISICOES_DEMAIS = {
  statusCode: HttpStatus.TOO_MANY_REQUESTS,
  code: 'REQUISICOES_DEMAIS',
  message: 'Muitas requisições em pouco tempo. Tente de novo mais tarde.',
} as const;

/** Prefixos separados: sem eles, o IP `x` e o usuário `x` cairiam no mesmo
 *  balde, e um abusador escolheria em qual balde alheio cair. */
export const PREFIXO_USUARIO = 'usuario:';
export const PREFIXO_IP = 'ip:';

/**
 * O guard global do projeto. Conta por **usuário** quando o Bearer token
 * confere, e por IP quando não confere ou não existe.
 */
@Injectable()
export class ThrottlerPorUsuario extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Request): Promise<string> {
    const sub = await this.subConferido(req);
    if (sub) {
      return `${PREFIXO_USUARIO}${sub}`;
    }
    return `${PREFIXO_IP}${req.ip ?? 'desconhecido'}`;
  }

  /**
   * `null` sempre que houver qualquer dúvida — sem header, formato errado,
   * assinatura inválida, expirado, ou `sub` ausente. Quem não provou quem é
   * conta por IP.
   */
  private async subConferido(req: Request): Promise<string | null> {
    const header = req.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return null;
    }
    const secret = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      // O app não sobe sem esta variável (a strategy usa `getOrThrow`), mas
      // um guard que estoura aqui derrubaria TODA requisição por causa do
      // limite de abuso. Degradar para IP é a falha certa neste ponto.
      return null;
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(
        header.slice('Bearer '.length),
        { secret },
      );
      return typeof payload?.sub === 'string' && payload.sub.length > 0
        ? payload.sub
        : null;
    } catch {
      return null;
    }
  }

  protected throwThrottlingException(): Promise<void> {
    // O 429 do throttler não traz `code`, e a convenção do projeto é que
    // erro de domínio traga um estável — frontend que decide por string de
    // mensagem quebra na primeira revisão de texto.
    throw new HttpException(REQUISICOES_DEMAIS, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Aplicado junto com `@UploadDeMidia()`, e é de propósito: a rota da
 * SPEC-018 não escolhe se quer limite. **Limite que a rota pode esquecer de
 * pedir é limite que uma rota nova não vai ter.**
 */
export function LimiteDeUpload(): MethodDecorator {
  return Throttle({
    default: { limit: LIMITE_DE_UPLOADS, ttl: JANELA_DE_UPLOAD_MS },
  });
}

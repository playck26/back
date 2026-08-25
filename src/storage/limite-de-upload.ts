import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
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
 * no teto do colega, e um abusador com IP rotativo passaria batido. Rota
 * pública continua por IP, porque lá não há usuário.
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

/**
 * O guard global do projeto. Conta por **usuário** quando há um, e por IP
 * quando não há.
 */
@Injectable()
export class ThrottlerPorUsuario extends ThrottlerGuard {
  protected getTracker(req: Request): Promise<string> {
    const usuario = (req as Request & { user?: AccessTokenPayload }).user;
    if (usuario?.sub) {
      return Promise.resolve(`usuario:${usuario.sub}`);
    }
    return Promise.resolve(`ip:${req.ip ?? 'desconhecido'}`);
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

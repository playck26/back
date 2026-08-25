import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/**
 * SPEC-017/TASK-006 — quem conta por IP, e por quê (4ª validação cruzada).
 *
 * Depois que o guard global passou a contar por **usuário**, apareceu uma
 * aresta que a revisão externa pegou: **rota pública com Bearer válido
 * deixava de contar por IP.**
 *
 * Para a maioria das rotas isso é o comportamento certo. Para `/auth/login`
 * é uma regressão de segurança, e não pequena: **este produto tem
 * auto-cadastro.** Um atacante cria contas à vontade, e cada token válido
 * lhe daria um balde novo de 10 tentativas — o teto de força bruta viraria
 * "10 vezes o número de contas que ele quiser criar". Por IP, é 10, ponto.
 *
 * Reproduzido antes de consertar, num teto de 2:
 *
 * ```
 * GET /publica  x2      -> 200, 200
 * GET /publica          -> 429      (balde do IP estourado)
 * GET /publica + Bearer -> 200      <-- escapou
 * ```
 *
 * **A regra:** onde o limite existe para conter quem ainda não é ninguém, a
 * chave é o IP — mesmo que a requisição venha com token. Identidade só
 * pode *estreitar* o limite, nunca *comprar* um limite novo.
 *
 * ---
 *
 * **Por que os dois limites moram aqui, e não em cada controller.** Eles
 * estavam duplicados em três arquivos, com o mesmo número escrito três
 * vezes. Pior: `@Throttle(...)` e a contagem por IP são **duas metades de
 * uma decisão só**, e separadas seria questão de tempo até alguém aplicar
 * uma sem a outra — que é literalmente o defeito que esta rodada consertou.
 * Mesmo raciocínio da INV-048 no `@UploadDeMidia()`.
 */
export const CONTAGEM_POR_IP = 'throttle:contagem-por-ip';

/**
 * Marca a rota (ou o controller) para contar **sempre por IP**, mesmo com
 * token válido. O guard lê esta marca antes de olhar o `Authorization`.
 */
export const ContagemPorIp = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CONTAGEM_POR_IP, true);

/** NFR-002: 10 tentativas / 15 min **por IP**. */
export const LOGIN_THROTTLE = { default: { limit: 10, ttl: 900_000 } };

/** Superfície pública sem login: mesmo teto, mesma razão. */
export const PUBLICO_THROTTLE = { default: { limit: 10, ttl: 900_000 } };

/**
 * Login, aceite de convite, auto-cadastro — tudo que um desconhecido pode
 * chamar para adivinhar credencial ou enumerar conta.
 */
export function LimiteDeLogin(): MethodDecorator {
  return applyDecorators(Throttle(LOGIN_THROTTLE), ContagemPorIp());
}

/** Leitura pública (vitrine da empresa, dados de convite). */
export function LimitePublico(): MethodDecorator {
  return applyDecorators(Throttle(PUBLICO_THROTTLE), ContagemPorIp());
}

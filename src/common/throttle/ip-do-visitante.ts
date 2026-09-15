import { isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';

/**
 * DEF-031 — **quem é o visitante, para o limite "por IP".**
 *
 * ## O que foi medido em produção (2026-09-15)
 *
 * Sondas no App Platform, lidas no log de um diagnóstico temporário:
 *
 * | Fonte | O que traz |
 * |---|---|
 * | `req.ip` / socket | `100.127.3.147` — o servidor de entrada da DigitalOcean, **o mesmo para todo visitante** |
 * | `X-Forwarded-For` | `<visitante>,<borda da Cloudflare>` — e **aceita valor forjado na frente** |
 * | `do-connecting-ip` | **o visitante**; um valor forjado pelo cliente é **sobrescrito** pela plataforma |
 *
 * O limite contava pelo socket, então os "10 por IP a cada 15 minutos" de
 * `/auth/login` eram do clube inteiro: o 11º login em 15 minutos levava `429`.
 * A correção que estava em PR (`trust proxy = 1`, back#95) teria trocado o
 * balanceador pela **Cloudflare** — outro IP compartilhado.
 *
 * ## A regra
 *
 * - **`do-connecting-ip` quando é um IP válido**; senão, o `req.ip`.
 * - **IPv6 conta pelo prefixo /64.** Um provedor entrega um /64 por cliente; contar
 *   o endereço inteiro daria ao atacante 2^64 baldes para a força bruta.
 * - **IPv4 embutido em IPv6** (`::ffff:a.b.c.d`, como o Node entrega o socket) vira
 *   o IPv4.
 * - `X-Forwarded-For` é ignorado.
 *
 * ## O limite desta confiança
 *
 * Confiar em `do-connecting-ip` só é seguro **porque a DigitalOcean o sobrescreve**
 * (medido). **Se o `back` sair do App Platform**, este cabeçalho vira texto do
 * cliente, e um atacante ganharia um balde por pedido — esta linha tem de mudar
 * junto com a hospedagem (registrado em `OPERATIONS.md`).
 */
export const CABECALHO_DO_IP_DO_VISITANTE = 'do-connecting-ip';

const PREFIXO_IPV4_EMBUTIDO = '::ffff:';

/** Os oito grupos de um IPv6 válido, sem abreviação, em minúsculas. */
function gruposDoIpv6(ip: string): string[] {
  const [inicio, fim] = ip.toLowerCase().split('::');
  const esquerda = inicio ? inicio.split(':') : [];
  const direita = fim === undefined ? [] : fim ? fim.split(':') : [];
  const faltam = fim === undefined ? 0 : 8 - esquerda.length - direita.length;
  return [...esquerda, ...Array<string>(faltam).fill('0'), ...direita].map(
    (grupo) => grupo.replace(/^0+(?=.)/, ''),
  );
}

/** A chave de UM endereço: IPv4 como está, IPv6 pelo /64. */
export function chaveDoIp(ip: string): string {
  const semEmbutido = ip.toLowerCase().startsWith(PREFIXO_IPV4_EMBUTIDO)
    ? ip.slice(PREFIXO_IPV4_EMBUTIDO.length)
    : ip;
  if (isIPv4(semEmbutido)) {
    return semEmbutido;
  }
  if (isIPv6(ip)) {
    return `${gruposDoIpv6(ip).slice(0, 4).join(':')}::/64`;
  }
  return ip;
}

/** A chave do visitante da requisição — nunca vazia. */
export function chaveDoVisitante(req: Request): string {
  const cabecalho = req.headers?.[CABECALHO_DO_IP_DO_VISITANTE];
  if (
    typeof cabecalho === 'string' &&
    (isIPv4(cabecalho) || isIPv6(cabecalho))
  ) {
    return chaveDoIp(cabecalho);
  }
  return req.ip ? chaveDoIp(req.ip) : 'desconhecido';
}

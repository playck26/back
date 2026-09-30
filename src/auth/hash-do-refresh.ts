import { createHash, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';

/**
 * SPEC-081/D1 — **o hash do refresh token é SHA-256, não bcrypt.**
 *
 * O bcrypt custava 267 ms de CPU por operação, duas por refresh, e não
 * protegia nada: ele só lê os primeiros 72 bytes, e dois refresh tokens do
 * mesmo usuário só se diferenciam depois disso. A proteção real é a
 * assinatura do JWT, a busca da linha pelo `jti` e a claim atômica do
 * `revokedAt`. É o mesmo formato que o convite já usa
 * (`invites.service.ts`).
 */
export function hashDoRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// O formato que `hashDoRefresh` produz: 64 hexadecimais minúsculos.
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Confere o token entregue contra o hash guardado na linha do `jti`.
 *
 * - `$2…` — **legado** (I3): linha emitida antes do deploy, ainda em bcrypt.
 *   Vale uma última vez; a rotação a substitui por SHA-256. O ramo sai numa
 *   spec de limpeza depois de 7 dias do deploy (LIM-081a).
 * - 64 hexadecimais — `timingSafeEqual` dos dois buffers de 32 bytes.
 * - qualquer outro formato — recusa, **antes** de comparar (AC-007): um
 *   buffer de tamanho diferente faria o `timingSafeEqual` lançar, e o
 *   refresh responderia 500 em vez de 401.
 */
export async function confereHashDoRefresh(
  token: string,
  guardado: string,
): Promise<boolean> {
  if (guardado.startsWith('$2')) {
    return bcrypt.compare(token, guardado);
  }
  if (!SHA256_HEX.test(guardado)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(hashDoRefresh(token), 'hex'),
    Buffer.from(guardado, 'hex'),
  );
}

import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';

// AC-003 — o espião tem de estar no lugar de onde o módulo importa. Um
// `jest.spyOn` no objeto do módulo não alcança a ligação que o `import`
// nomeado já resolveu; o `jest.mock` troca antes.
jest.mock('node:crypto', () => {
  const real = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...real, timingSafeEqual: jest.fn(real.timingSafeEqual) };
});

import { timingSafeEqual } from 'node:crypto';
import { confereHashDoRefresh, hashDoRefresh } from './hash-do-refresh';

const espiao = timingSafeEqual as jest.MockedFunction<typeof timingSafeEqual>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Troca o último hexadecimal: os 16 primeiros continuam iguais (AC-002).
function mudarDepoisDo16(hash: string): string {
  const ultimo = hash[63] === '0' ? '1' : '0';
  return hash.slice(0, 63) + ultimo;
}

describe('SPEC-081 — hash do refresh token', () => {
  beforeEach(() => espiao.mockClear());

  it('AC-001: é o SHA-256 hexadecimal do token (64 caracteres)', () => {
    const h = hashDoRefresh('um.jwt.qualquer');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha('um.jwt.qualquer'));
  });

  it('AC-002: o token certo confere', async () => {
    await expect(
      confereHashDoRefresh('token-a', hashDoRefresh('token-a')),
    ).resolves.toBe(true);
  });

  it('AC-002: hash que difere só depois do 16º caractere NÃO confere', async () => {
    const guardado = mudarDepoisDo16(hashDoRefresh('token-a'));
    expect(guardado.slice(0, 16)).toBe(hashDoRefresh('token-a').slice(0, 16));
    expect(guardado).not.toBe(hashDoRefresh('token-a'));

    await expect(confereHashDoRefresh('token-a', guardado)).resolves.toBe(
      false,
    );
  });

  it('AC-003: a comparação SHA-256 passa por timingSafeEqual, com 32 bytes de cada lado', async () => {
    await confereHashDoRefresh('token-a', hashDoRefresh('token-a'));
    await confereHashDoRefresh('token-a', hashDoRefresh('token-b'));

    expect(espiao).toHaveBeenCalledTimes(2);
    for (const [x, y] of espiao.mock.calls) {
      expect((x as Buffer).length).toBe(32);
      expect((y as Buffer).length).toBe(32);
    }
  });

  it('AC-006: hash bcrypt legado ainda confere (e não passa por timingSafeEqual)', async () => {
    const legado = await bcrypt.hash('token-antigo', 4);
    expect(legado.startsWith('$2')).toBe(true);

    await expect(confereHashDoRefresh('token-antigo', legado)).resolves.toBe(
      true,
    );
    await expect(confereHashDoRefresh('outro-token', legado)).resolves.toBe(
      false,
    );
    expect(espiao).not.toHaveBeenCalled();
  });

  it.each([
    ['vazio', ''],
    ['hexadecimal curto', 'abc123'],
    ['64 caracteres que não são hexadecimais', 'z'.repeat(64)],
    ['hexadecimal maiúsculo', 'A'.repeat(64)],
    ['65 hexadecimais', 'a'.repeat(65)],
  ])(
    'AC-007: formato desconhecido (%s) recusa antes de timingSafeEqual',
    async (_nome, guardado) => {
      await expect(confereHashDoRefresh('token-a', guardado)).resolves.toBe(
        false,
      );
      expect(espiao).not.toHaveBeenCalled();
    },
  );
});

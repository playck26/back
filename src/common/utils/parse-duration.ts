const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Converte formato curto ("15m", "7d") usado em JWT_*_EXPIRES_IN para ms. */
export function parseDurationToMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Duração inválida: "${value}" (use algo como "15m" ou "7d")`,
    );
  }
  const [, amount, unit] = match;
  return Number(amount) * UNIT_TO_MS[unit];
}

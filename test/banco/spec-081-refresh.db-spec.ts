/**
 * SPEC-081/TASK-001 — **o hash do refresh token, contra banco real.**
 *
 * O unitário prova a conferência; aqui prova-se o que fica GRAVADO em
 * `refresh_tokens.token_hash`, que é o que o próximo refresh lê: o SHA-256 do
 * token entregue (AC-001), a recusa sem revogar quando o hash não bate
 * (AC-002), e a linha legada em bcrypt que ainda rotaciona uma vez (AC-006).
 */
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { AuthService } from '../../src/auth/auth.service';
import type { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

const EMPRESA = '08100000-0000-4000-8000-000000000001';
const GESTOR = '08100000-0000-4000-8000-000000000002';
const EMAIL = 'spec081-refresh@teste.local';
const SENHA = 'spec-081-senha-forte';
const REFRESH_SECRET = 'segredo-de-refresh-do-teste-081';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const config = {
  get: (k: string, padrao?: string) =>
    ({ JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' })[k] ??
    padrao,
  getOrThrow: (k: string) =>
    ({
      JWT_ACCESS_SECRET: 'segredo-de-acesso-do-teste-081',
      JWT_REFRESH_SECRET: REFRESH_SECRET,
    })[k] as string,
} as unknown as ConfigService;
const jwt = new JwtService();
const service = new AuthService(
  db as unknown as PrismaService,
  {} as StudentsService,
  jwt,
  config,
);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const jtiDe = (token: string) => jwt.decode<{ jti: string }>(token).jti;

async function linha(id: string) {
  const [r] = await db.$queryRawUnsafe<
    { tokenHash: string; revogado: boolean }[]
  >(
    `SELECT token_hash AS "tokenHash", revoked_at IS NOT NULL AS revogado
       FROM refresh_tokens WHERE id = $1::uuid`,
    id,
  );
  return r;
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-081','spec-081-refresh',now())`,
    ),
  );
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${GESTOR}','${EMAIL}','${hash}','Gestor 081','company_admin','${EMPRESA}',now())`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-081 — refresh token guardado em SHA-256', () => {
  it('AC-001: login e refresh gravam o SHA-256 do token entregue', async () => {
    const { refreshToken } = await service.login({
      email: EMAIL,
      senha: SENHA,
    });
    const doLogin = await linha(jtiDe(refreshToken));
    expect(doLogin.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doLogin.tokenHash).toBe(sha256(refreshToken));

    const novo = await service.refresh(refreshToken);
    const doRefresh = await linha(jtiDe(novo.refreshToken));
    expect(doRefresh.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doRefresh.tokenHash).toBe(sha256(novo.refreshToken));
    expect((await linha(jtiDe(refreshToken))).revogado).toBe(true);
  });

  it('AC-002: assinatura válida com SHA-256 que não bate responde 401 e NÃO revoga a linha', async () => {
    const { refreshToken } = await service.login({
      email: EMAIL,
      senha: SENHA,
    });
    const jti = jtiDe(refreshToken);
    // Mesmo `sub` e `jti`, assinado com o segredo certo, mas outro token:
    // a assinatura passa, a linha é achada, e o hash não confere.
    const outro = await jwt.signAsync(
      { sub: GESTOR, jti, extra: 'diferente' },
      { secret: REFRESH_SECRET, expiresIn: '7d' },
    );
    expect(outro).not.toBe(refreshToken);

    await expect(service.refresh(outro)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((await linha(jti)).revogado).toBe(false);

    // E a linha continua servindo ao dono.
    await expect(service.refresh(refreshToken)).resolves.toHaveProperty(
      'refreshToken',
    );
  });

  it('AC-006: linha legada em bcrypt rotaciona uma vez, e a nova sai em SHA-256', async () => {
    const jti = randomUUID();
    const legado = await jwt.signAsync(
      { sub: GESTOR, jti },
      { secret: REFRESH_SECRET, expiresIn: '7d' },
    );
    const hashLegado = await bcrypt.hash(legado, 4);
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at,created_at)
       VALUES ('${jti}','${GESTOR}','${hashLegado}',now() + interval '7 days',now())`,
    );

    const novo = await service.refresh(legado);

    expect((await linha(jti)).revogado).toBe(true);
    const nova = await linha(jtiDe(novo.refreshToken));
    expect(nova.tokenHash).toBe(sha256(novo.refreshToken));
    // Uma vez só: a segunda é reuso.
    await expect(service.refresh(legado)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

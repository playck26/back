/**
 * SPEC-086/AC-007 — **a caracterização do login de UMA conta, escrita contra o
 * `main` (b748fa8) antes de qualquer código da 086.**
 *
 * A 086 troca o `findUnique` por e-mail por uma busca de várias contas. A
 * promessa é que, com uma conta só, nada muda — e esta suíte é a régua. Ela
 * roda pela HTTP real (`createTestApp` com um `PrismaClient` de verdade), para
 * não depender de qual método do Prisma o login usa.
 *
 * **Não é regravada depois do código novo** (S13): o DoD confere que o blob
 * deste arquivo no commit da captura é idêntico ao do `HEAD`.
 *
 * O que é aleatório (`jti`, assinatura, horários) é conferido por forma.
 */
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from '../utils/create-test-app';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';
import { garantirAmbienteDeFit } from '../fit/app-real';

jest.setTimeout(120_000);
exigirBancoLocal();

const EMPRESA = '08600000-0000-4000-8000-000000000001';
const EMPRESA_INATIVA = '08600000-0000-4000-8000-000000000002';
const CONTA = '08600000-0000-4000-8000-000000000010';
const CONTA_INATIVA = '08600000-0000-4000-8000-000000000011';
const CONTA_EMPRESA_INATIVA = '08600000-0000-4000-8000-000000000012';
const CONTA_VENCIDA = '08600000-0000-4000-8000-000000000013';
const SENHA = 'spec-086-senha-forte';

const EMAIL = 'spec086-carac@teste.local';
const EMAIL_INATIVA = 'spec086-carac-inativa@teste.local';
const EMAIL_EMPRESA_INATIVA = 'spec086-carac-empresa-inativa@teste.local';
const EMAIL_VENCIDA = 'spec086-carac-vencida@teste.local';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const jwt = new JwtService();
let app: INestApplication<App>;

const CREDENCIAIS_INVALIDAS = {
  statusCode: 401,
  message: 'Credenciais inválidas',
  error: 'Unauthorized',
};

async function conta(
  id: string,
  email: string,
  empresa: string,
  extra = '',
  extraValores = '',
) {
  const hash = await bcrypt.hash(SENHA, 4);
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,telefone,role,company_id,updated_at${extra})
     VALUES ('${id}','${email}','${hash}','Aluno 086','11999990000','aluno','${empresa}',now()${extraValores})`,
  );
}

async function refreshVivos(usuarioId: string): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM refresh_tokens
      WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
    usuarioId,
  );
  return r.n;
}

async function refreshTotal(usuarioId: string): Promise<number> {
  const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM refresh_tokens WHERE usuario_id = $1::uuid`,
    usuarioId,
  );
  return r.n;
}

const login = (email: string, senha = SENHA) =>
  request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, senha });

beforeAll(async () => {
  garantirAmbienteDeFit();
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_INATIVA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-086','spec-086-carac',now())`,
    ),
  );
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,status,updated_at) VALUES ('${EMPRESA_INATIVA}','SPEC-086 inativa','spec-086-carac-inativa','inativa',now())`,
    ),
  );
  await conta(CONTA, EMAIL, EMPRESA);
  await conta(CONTA_INATIVA, EMAIL_INATIVA, EMPRESA, ',status', ",'inativo'");
  await conta(CONTA_EMPRESA_INATIVA, EMAIL_EMPRESA_INATIVA, EMPRESA_INATIVA);
  await conta(
    CONTA_VENCIDA,
    EMAIL_VENCIDA,
    EMPRESA,
    ',senha_temporaria,senha_temporaria_expira_em',
    ",true,now() - interval '1 day'",
  );
  app = await createTestApp(db);
});

afterAll(async () => {
  await app?.close();
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_INATIVA);
  await db.$disconnect();
});

describe('SPEC-086/AC-007 — o login de uma conta, como é no main', () => {
  it('uma conta válida: 200, o corpo, as claims, o cookie e uma linha de refresh', async () => {
    const antes = await refreshTotal(CONTA);
    const res = await login(EMAIL);

    expect(res.status).toBe(200);
    const corpo = res.body as {
      accessToken: string;
      refreshToken: string;
      usuario: Record<string, unknown>;
    };
    expect(Object.keys(corpo).sort()).toEqual(
      ['accessToken', 'refreshToken', 'usuario'].sort(),
    );
    expect(corpo.usuario).toEqual({
      id: CONTA,
      email: EMAIL,
      nome: 'Aluno 086',
      role: 'aluno',
      companyId: EMPRESA,
      senhaTemporaria: false,
    });

    const claims = jwt.decode<Record<string, unknown>>(corpo.accessToken);
    expect(Object.keys(claims).sort()).toEqual(
      ['companyId', 'email', 'exp', 'iat', 'nome', 'role', 'sub'].sort(),
    );
    expect(claims).toMatchObject({
      sub: CONTA,
      email: EMAIL,
      nome: 'Aluno 086',
      role: 'aluno',
      companyId: EMPRESA,
    });
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');

    const refreshClaims = jwt.decode<Record<string, unknown>>(
      corpo.refreshToken,
    );
    expect(Object.keys(refreshClaims).sort()).toEqual(
      ['exp', 'iat', 'jti', 'sub'].sort(),
    );
    expect(refreshClaims.sub).toBe(CONTA);

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0];
    expect(cookie.startsWith(`refresh_token=${corpo.refreshToken};`)).toBe(
      true,
    );
    expect(cookie).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie).toMatch(/; SameSite=Strict(;|$)/);
    expect(cookie).toMatch(/; Max-Age=\d+(;|$)/);

    expect(await refreshTotal(CONTA)).toBe(antes + 1);
  });

  it('senha errada: 401 genérico, sem cookie', async () => {
    const res = await login(EMAIL, 'outra-senha-qualquer');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('e-mail sem conta: o mesmo 401 genérico', async () => {
    const res = await login('spec086-ninguem@teste.local');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
  });

  it('conta inativa: o mesmo 401 genérico', async () => {
    const res = await login(EMAIL_INATIVA);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
  });

  it('empresa inativa: o mesmo 401 genérico', async () => {
    const res = await login(EMAIL_EMPRESA_INATIVA);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CREDENCIAIS_INVALIDAS);
  });

  it('senha temporária vencida: 401 SENHA_TEMPORARIA_EXPIRADA e os refresh da conta revogados', async () => {
    await q(
      `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at)
       VALUES (gen_random_uuid(),'${CONTA_VENCIDA}','x',now() + interval '1 day')`,
    );
    expect(await refreshVivos(CONTA_VENCIDA)).toBe(1);

    const res = await login(EMAIL_VENCIDA);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      statusCode: 401,
      code: 'SENHA_TEMPORARIA_EXPIRADA',
      message:
        'Senha temporária expirada. Peça ao administrador da sua empresa uma nova.',
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await refreshVivos(CONTA_VENCIDA)).toBe(0);
  });
});

/**
 * SPEC-081/TASK-002 — **o portão do guard em uma consulta, contra banco real.**
 *
 * AC-010: a leitura é pelo `id` do token. Dois usuários na mesma empresa, A
 * inativo e B ativo: o token de B passa, o de A leva `CONTA_INATIVA`. Um id
 * fixo no lugar do `sub` troca um pelo outro, e isso fica vermelho.
 *
 * E a equivalência que justifica trocar o mecanismo: para cada usuário da
 * fixture, a linha do `$queryRaw` é IGUAL à do `findUnique` com o `select`
 * que o guard usava antes — inclusive o `super_admin`, sem empresa.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { lerPortaoDoUsuario } from '../../src/common/guards/portao-do-usuario';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { comNivelDaFixture } from './nivel-da-fixture';

// O guard é o real; só o Passport vira um stub que autentica.
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () =>
    class {
      canActivate(): boolean {
        return true;
      }
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JwtAuthGuard } = require('../../src/common/guards/jwt-auth.guard') as {
  JwtAuthGuard: new (
    reflector: Reflector,
    prisma: unknown,
  ) => { canActivate: (ctx: ExecutionContext) => Promise<boolean> };
};

jest.setTimeout(120_000);
exigirBancoLocal();

const EMPRESA = '08100000-0000-4000-8000-000000000101';
const A_INATIVO = '08100000-0000-4000-8000-00000000010a';
const B_ATIVO = '08100000-0000-4000-8000-00000000010b';
const ALUNO = '08100000-0000-4000-8000-00000000010c';
const SUPER = '08100000-0000-4000-8000-00000000010d';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
const guard = new JwtAuthGuard(reflector, db);

function contexto(sub: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { sub } }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

async function codigo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'PASSOU';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ?? String(e);
  }
}

function usuario(
  id: string,
  role: string,
  status: string,
  extra: { empresa?: string | null; termo?: number | null } = {},
) {
  const empresa =
    extra.empresa === null ? 'NULL' : `'${extra.empresa ?? EMPRESA}'`;
  const termo = extra.termo == null ? 'NULL' : String(extra.termo);
  return q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,status,termo_versao_aceita,updated_at)
     VALUES ('${id}','${id}@spec081.local','x','${role} 081','${role}',${empresa},'${status}',${termo},now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(`DELETE FROM usuarios WHERE id = '${SUPER}'`);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,contrato_versao_vigente,updated_at) VALUES ('${EMPRESA}','SPEC-081 guard','spec-081-guard',2,now())`,
    ),
  );
  await usuario(A_INATIVO, 'company_admin', 'inativo');
  await usuario(B_ATIVO, 'company_admin', 'ativo');
  await usuario(ALUNO, 'aluno', 'ativo', { termo: 1 });
  await usuario(SUPER, 'super_admin', 'ativo', { empresa: null });
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(`DELETE FROM usuarios WHERE id = '${SUPER}'`);
  await db.$disconnect();
});

describe('SPEC-081 AC-010 — o portão lê o usuário do token', () => {
  it('token de B (ativo) passa', async () => {
    await expect(codigo(guard.canActivate(contexto(B_ATIVO)))).resolves.toBe(
      'PASSOU',
    );
  });

  it('token de A (inativo) leva 403 CONTA_INATIVA', async () => {
    await expect(codigo(guard.canActivate(contexto(A_INATIVO)))).resolves.toBe(
      'CONTA_INATIVA',
    );
  });

  it('super_admin, sem empresa, passa', async () => {
    await expect(codigo(guard.canActivate(contexto(SUPER)))).resolves.toBe(
      'PASSOU',
    );
  });
});

describe('SPEC-081 D2 — a linha do $queryRaw é a do findUnique de antes', () => {
  it.each([
    ['A inativo', A_INATIVO],
    ['B ativo', B_ATIVO],
    ['aluno com contrato vigente', ALUNO],
    ['super_admin sem empresa', SUPER],
    ['id que não existe', '08100000-0000-4000-8000-0000000001ff'],
  ])('%s', async (_nome, id) => {
    const antes = await db.usuario.findUnique({
      where: { id },
      select: {
        senhaTemporaria: true,
        status: true,
        role: true,
        termoVersaoAceita: true,
        contratoVersaoAceita: true,
        empresa: { select: { contratoVersaoVigente: true, status: true } },
      },
    });
    await expect(lerPortaoDoUsuario(db, id)).resolves.toEqual(antes);
  });
});

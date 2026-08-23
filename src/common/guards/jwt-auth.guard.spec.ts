import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// O comportamento sob teste é o da SPEC-009 (INV-008), não o do Passport:
// o mixin `AuthGuard` é substituído por um stub que sempre autentica, para
// que o teste isole a trava de senha temporária.
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () =>
    class {
      canActivate(): boolean {
        return true;
      }
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JwtAuthGuard } = require('./jwt-auth.guard') as {
  JwtAuthGuard: new (
    reflector: Reflector,
    prisma: unknown,
  ) => { canActivate: (ctx: ExecutionContext) => Promise<boolean> };
};

function buildContext(usuarioId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => (usuarioId ? { user: { sub: usuarioId } } : {}),
    }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard — trava de senha temporária (SPEC-009/INV-008)', () => {
  const buildReflector = (permite: boolean) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(permite),
    }) as unknown as Reflector;

  const buildPrisma = (
    senhaTemporaria: boolean | undefined,
    status: 'ativo' | 'inativo' = 'ativo',
  ) => ({
    usuario: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          senhaTemporaria === undefined ? null : { senhaTemporaria, status },
        ),
    },
  });

  it('bloqueia rota comum quando a conta está com senha temporária', async () => {
    const guard = new JwtAuthGuard(buildReflector(false), buildPrisma(true));

    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // Este teste afirmava, ate 2026-08-22, que a rota marcada passava **sem
  // consultar o banco**. Aquilo era uma otimizacao virada regra: economizava
  // uma query e, de quebra, criava a brecha de INV-013 — conta inativa
  // trocando a propria senha e entrando. A consulta agora sempre acontece;
  // o que a marcacao dispensa e a trava de senha temporaria, so ela.
  it('libera rota marcada com @PermiteSenhaTemporaria, mas ainda consulta o banco (INV-013)', async () => {
    const prisma = buildPrisma(true);
    const guard = new JwtAuthGuard(buildReflector(true), prisma);

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
    expect(prisma.usuario.findUnique).toHaveBeenCalled();
  });

  it('deixa passar conta com senha própria', async () => {
    const guard = new JwtAuthGuard(buildReflector(false), buildPrisma(false));

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  // Regressão: a trava não pode virar erro 500 se o token vier sem `sub`
  // (cenário de token forjado/malformado que o Passport tenha deixado
  // passar) — a decisão de barrar é de quem valida credencial.
  it('não quebra quando não há usuário na requisição', async () => {
    const guard = new JwtAuthGuard(buildReflector(false), buildPrisma(true));

    await expect(guard.canActivate(buildContext())).resolves.toBe(true);
  });
});

// SPEC-013/DEF-001. Antes desta correcao, `usuarios.status` nao era lido em
// lugar nenhum do `src/` — o gestor inativava alguem, o badge mudava, e a
// pessoa seguia operando com o access token que ja tinha na mao (ate 15 min)
// e conseguia fazer login de novo depois disso.
describe('JwtAuthGuard — conta inativa (SPEC-013/INV-013)', () => {
  const buildReflector = (permite: boolean) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(permite),
    }) as unknown as Reflector;

  const prismaInativo = () => ({
    usuario: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ senhaTemporaria: false, status: 'inativo' }),
    },
  });

  it('barra token ja emitido de conta inativada', async () => {
    const guard = new JwtAuthGuard(buildReflector(false), prismaInativo());

    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // O ponto mais facil de errar: `@PermiteSenhaTemporaria` marca
  // /auth/trocar-senha, /auth/me e logout. Se a checagem de status ficasse
  // depois do atalho da marcacao, uma conta inativa trocaria a senha e
  // voltaria a operar — INV-013 furada pela porta que existe justamente
  // para quem ainda nao pode operar.
  it('barra tambem em rota @PermiteSenhaTemporaria', async () => {
    const guard = new JwtAuthGuard(buildReflector(true), prismaInativo());

    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

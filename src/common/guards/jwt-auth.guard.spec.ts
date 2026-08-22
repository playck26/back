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

  const buildPrisma = (senhaTemporaria: boolean | undefined) => ({
    usuario: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          senhaTemporaria === undefined ? null : { senhaTemporaria },
        ),
    },
  });

  it('bloqueia rota comum quando a conta está com senha temporária', async () => {
    const guard = new JwtAuthGuard(buildReflector(false), buildPrisma(true));

    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('libera rota marcada com @PermiteSenhaTemporaria sem nem consultar o banco', async () => {
    const prisma = buildPrisma(true);
    const guard = new JwtAuthGuard(buildReflector(true), prisma);

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
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

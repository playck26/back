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

/**
 * SPEC-024/INV-024b — o portão do aceite.
 *
 * A prova que mais importa aqui não é a que bloqueia: é a **9**, que garante
 * que o `company_admin` NÃO é bloqueado. Sem ela o portão trancaria a
 * própria saída — o gestor precisaria aceitar o contrato para entrar no
 * Admin, e um termo novo da plataforma impediria qualquer um de publicar o
 * contrato que destravaria os alunos. Portão que tranca a saída não é
 * portão, é armadilha.
 */
describe('JwtAuthGuard — portão do aceite (SPEC-024)', () => {
  const reflector = (permiteAceite: boolean) =>
    ({
      // O guard consulta duas chaves; a de senha temporária responde false
      // (rota comum) e a do aceite responde o que o teste pedir.
      getAllAndOverride: jest.fn((chave: string) =>
        chave === 'permiteAceitePendente' ? permiteAceite : false,
      ),
    }) as unknown as Reflector;

  const prisma = (usuario: Record<string, unknown>) => ({
    usuario: {
      findUnique: jest.fn().mockResolvedValue({
        senhaTemporaria: false,
        status: 'ativo',
        termoVersaoAceita: 1,
        contratoVersaoAceita: null,
        empresa: { contratoVersaoVigente: null },
        ...usuario,
      }),
    },
  });

  const codigo = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'NAO_LANCOU';
    } catch (e) {
      const r = (e as { getResponse?: () => unknown }).getResponse?.();
      return (r as { code?: string })?.code ?? 'SEM_CODIGO';
    }
  };

  it('prova 1 — aluno sem aceitar o termo é bloqueado', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({ role: 'aluno', termoVersaoAceita: null }),
    );

    await expect(codigo(guard.canActivate(buildContext('u1')))).resolves.toBe(
      'ACEITE_PENDENTE',
    );
  });

  it('prova 2 — mas a rota marcada continua aberta, senão ele fica preso', async () => {
    // Bloqueado por não ter aceitado, e sem como ler o que precisa aceitar:
    // seria uma porta trancada por dentro.
    const guard = new JwtAuthGuard(
      reflector(true),
      prisma({ role: 'aluno', termoVersaoAceita: null }),
    );

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('prova 3 — contrato novo devolve o aluno à pendência', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({
        role: 'aluno',
        contratoVersaoAceita: 1,
        empresa: { contratoVersaoVigente: 2 },
      }),
    );

    await expect(codigo(guard.canActivate(buildContext('u1')))).resolves.toBe(
      'ACEITE_PENDENTE',
    );
  });

  it('prova 4 — clube sem contrato não trava ninguém', async () => {
    // É o estado de TODA empresa existente no dia da migration.
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({ role: 'aluno', empresa: { contratoVersaoVigente: null } }),
    );

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('prova 9 — company_admin NÃO é travado (o bloqueio circular)', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({
        role: 'company_admin',
        termoVersaoAceita: null,
        empresa: { contratoVersaoVigente: 3 },
      }),
    );

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('super_admin também não, e ele nem tem empresa', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({ role: 'super_admin', termoVersaoAceita: null, empresa: null }),
    );

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('professor é tratado como aluno aqui: usa o app, então aceita', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({ role: 'professor', termoVersaoAceita: null }),
    );

    await expect(codigo(guard.canActivate(buildContext('u1')))).resolves.toBe(
      'ACEITE_PENDENTE',
    );
  });

  it('em dia com os dois textos, passa', async () => {
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({
        role: 'aluno',
        termoVersaoAceita: 1,
        contratoVersaoAceita: 4,
        empresa: { contratoVersaoVigente: 4 },
      }),
    );

    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('senha temporária vem ANTES do aceite, e a ordem não é arbitrária', async () => {
    // Quem ainda não definiu senha própria resolve isso primeiro. Empilhar as
    // duas pendências seria pedir que a pessoa aceite um contrato antes de
    // ter uma conta de verdade.
    const guard = new JwtAuthGuard(
      reflector(false),
      prisma({
        role: 'aluno',
        senhaTemporaria: true,
        termoVersaoAceita: null,
      }),
    );

    await expect(codigo(guard.canActivate(buildContext('u1')))).resolves.toBe(
      'SENHA_TEMPORARIA',
    );
  });
});

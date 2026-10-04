/**
 * SPEC-081/D2 — o helper do portão nos dublês, e a ligação do `sub` (AC-010).
 *
 * Mora com sufixo `.e2e-spec.ts` porque é a configuração e2e que alcança
 * `test/`: um `.spec.ts` aqui não seria coletado por nenhuma das suítes.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  lerPortaoDoUsuario,
  MARCADOR_DO_PORTAO,
} from '../../src/common/guards/portao-do-usuario';
import { comPortaoDoUsuario } from './portao-no-duble';

// O guard sob teste é o real; só o Passport vira um stub que autentica.
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

const reflector = {
  getAllAndOverride: () => false,
} as unknown as Reflector;

function contexto(sub: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { sub } }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const LINHA = {
  senhaTemporaria: false,
  status: 'ativo',
  role: 'company_admin',
  termoVersaoAceita: 1,
  contratoVersaoAceita: 1,
  empresa: { contratoVersaoVigente: null, status: 'ativa' },
};

describe('SPEC-081 — comPortaoDoUsuario (roteia pelo marcador)', () => {
  it('a consulta do portão vai ao findUnique do dublê, com os argumentos de antes', async () => {
    const findUnique = jest.fn().mockResolvedValue(LINHA);
    const duble = comPortaoDoUsuario({ usuario: { findUnique } });

    await expect(lerPortaoDoUsuario(duble as never, 'u-1')).resolves.toEqual(
      LINHA,
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      select: {
        senhaTemporaria: true,
        status: true,
        role: true,
        termoVersaoAceita: true,
        contratoVersaoAceita: true,
        empresa: { select: { contratoVersaoVigente: true, status: true } },
      },
    });
  });

  it('usuário ausente no dublê vira lista vazia, e o portão lê null', async () => {
    const duble = comPortaoDoUsuario({
      usuario: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(lerPortaoDoUsuario(duble as never, 'u-1')).resolves.toBe(null);
  });

  it('DEF-VC031-02: o critério é o marcador, não o predicado', async () => {
    const findUnique = jest.fn().mockResolvedValue(LINHA);
    const anterior = jest.fn().mockResolvedValue([{ outra: 1 }]);
    const duble = comPortaoDoUsuario({
      usuario: { findUnique },
      $queryRaw: anterior,
    });
    const $queryRaw = duble.$queryRaw as unknown as (
      q: Prisma.Sql,
    ) => Promise<unknown>;

    // Com o marcador e SEM o predicado (uma sabotagem no WHERE): continua
    // indo ao findUnique — o dublê não muda de ramo.
    await expect(
      $queryRaw(
        Prisma.sql([`${MARCADOR_DO_PORTAO} SELECT 1 FROM usuarios`, ''], 'u-2'),
      ),
    ).resolves.toEqual([LINHA]);
    expect(findUnique).toHaveBeenCalledTimes(1);

    // Sem o marcador e COM o texto da consulta do portão: vai ao anterior.
    await expect(
      $queryRaw(
        Prisma.sql`SELECT * FROM usuarios u LEFT JOIN empresas e ON e.id = u.company_id WHERE u.id = ${'u-2'}::uuid`,
      ),
    ).resolves.toEqual([{ outra: 1 }]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(anterior).toHaveBeenCalledTimes(1);
  });

  it('sem $queryRaw anterior, consulta que não é do portão devolve []', async () => {
    const duble = comPortaoDoUsuario({
      usuario: { findUnique: jest.fn() },
    });
    const $queryRaw = duble.$queryRaw as unknown as (
      q: Prisma.Sql,
    ) => Promise<unknown>;
    await expect($queryRaw(Prisma.sql`SELECT 1`)).resolves.toEqual([]);
  });

  it('o $queryRaw do domínio segue observável como antes: o portão não entra em mock.calls, nem obedece ao mockResolvedValue do teste', async () => {
    const findUnique = jest.fn().mockResolvedValue(LINHA);
    const duble = comPortaoDoUsuario({
      usuario: { findUnique },
      $queryRaw: jest.fn().mockResolvedValue([]),
    });
    const $queryRaw = duble.$queryRaw;
    $queryRaw.mockClear();
    $queryRaw.mockResolvedValue([{ n: 7 }]);

    await expect(lerPortaoDoUsuario(duble as never, 'u-1')).resolves.toEqual(
      LINHA,
    );
    expect($queryRaw).not.toHaveBeenCalled();
    await expect($queryRaw(Prisma.sql`SELECT 7`)).resolves.toEqual([{ n: 7 }]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('SPEC-081 AC-010 — o portão liga o `sub` do token, e só ele', () => {
  it('o $queryRaw do guard recebe como ÚNICO valor ligado o sub do token', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([LINHA]);
    const guard = new JwtAuthGuard(reflector, { $queryRaw });

    await expect(
      guard.canActivate(contexto('9b1c7d4e-0000-4000-8000-00000000000b')),
    ).resolves.toBe(true);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [consulta] = $queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(consulta.strings[0].startsWith(MARCADOR_DO_PORTAO)).toBe(true);
    expect(consulta.values).toEqual(['9b1c7d4e-0000-4000-8000-00000000000b']);
  });
});

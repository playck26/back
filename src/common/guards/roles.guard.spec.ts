import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function buildContext(role: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { role } }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildReflector(rolesPermitidas: string[] | undefined) {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(rolesPermitidas),
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('deixa passar qualquer role autenticada quando a rota não declara @Roles', () => {
    const guard = new RolesGuard(buildReflector(undefined));
    expect(guard.canActivate(buildContext('aluno'))).toBe(true);
  });

  it('permite role listada em @Roles', () => {
    const guard = new RolesGuard(buildReflector(['company_admin', 'aluno']));
    expect(guard.canActivate(buildContext('aluno'))).toBe(true);
    expect(guard.canActivate(buildContext('company_admin'))).toBe(true);
  });

  it('rejeita role fora da lista de @Roles com 403', () => {
    const guard = new RolesGuard(buildReflector(['company_admin']));
    expect(() => guard.canActivate(buildContext('aluno'))).toThrow(
      ForbiddenException,
    );
  });
});

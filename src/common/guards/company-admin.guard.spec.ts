import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CompanyAdminGuard } from './company-admin.guard';

function buildContext(role: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('CompanyAdminGuard', () => {
  const guard = new CompanyAdminGuard();

  it('permite company_admin', () => {
    expect(guard.canActivate(buildContext('company_admin'))).toBe(true);
  });

  it('rejeita super_admin com 403', () => {
    expect(() => guard.canActivate(buildContext('super_admin'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejeita aluno com 403', () => {
    expect(() => guard.canActivate(buildContext('aluno'))).toThrow(
      ForbiddenException,
    );
  });
});

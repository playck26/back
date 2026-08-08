import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SuperAdminGuard } from './super-admin.guard';

// TEST-002 (SPEC-002, NFR-001/REQ-006): guard exclusivo de super_admin.

function buildContext(role: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('SuperAdminGuard', () => {
  const guard = new SuperAdminGuard();

  it('permite super_admin', () => {
    expect(guard.canActivate(buildContext('super_admin'))).toBe(true);
  });

  it('rejeita company_admin com 403 (AC-004)', () => {
    expect(() => guard.canActivate(buildContext('company_admin'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejeita aluno com 403', () => {
    expect(() => guard.canActivate(buildContext('aluno'))).toThrow(
      ForbiddenException,
    );
  });
});

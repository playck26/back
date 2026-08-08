import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

// TEST-001b (SPEC-001, AC-005): guard de tenant reutilizável.

function buildContext(
  user: { role: string; companyId: string | null },
  params: Record<string, string>,
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params }),
    }),
  } as unknown as ExecutionContext;
}

describe('TenantGuard', () => {
  const guard = new TenantGuard();

  it('permite super_admin em qualquer companyId', () => {
    const ctx = buildContext(
      { role: 'super_admin', companyId: null },
      { companyId: 'empresa-b' },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('permite quando o companyId da rota bate com o do usuário', () => {
    const ctx = buildContext(
      { role: 'company_admin', companyId: 'empresa-a' },
      { companyId: 'empresa-a' },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('retorna 404 (nunca 403) quando o companyId da rota é de outra empresa (AC-005)', () => {
    const ctx = buildContext(
      { role: 'company_admin', companyId: 'empresa-a' },
      { companyId: 'empresa-b' },
    );
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('permite quando a rota não tem :companyId (nada a comparar)', () => {
    const ctx = buildContext({ role: 'aluno', companyId: 'empresa-a' }, {});
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

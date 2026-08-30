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

  /**
   * **ACHADO DA 3ª VALIDAÇÃO CRUZADA — e o `UuidCanonicoPipe` NÃO chega
   * aqui.**
   *
   * Guard roda antes de pipe: o que este `canActivate` lê é `request.params`
   * cru, com a grafia da URL. O `companyId` do token é canônico (sai do
   * Postgres, via `usuario.companyId`/`empresa.id`), então a mesma empresa
   * em MAIÚSCULAS na rota virava `404` — o gestor barrado da própria
   * empresa.
   *
   * As provas acima usam `'empresa-a'`/`'empresa-b'`, apelidos sem caixa, e
   * por isso nenhuma delas podia pegar isto. Estas usam UUID com letra
   * hexadecimal.
   */
  const EMPRESA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OUTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('a MESMA empresa em MAIÚSCULAS na rota passa — UUID não é texto', () => {
    const ctx = buildContext(
      { role: 'company_admin', companyId: EMPRESA },
      { companyId: EMPRESA.toUpperCase() },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('OUTRA empresa em MAIÚSCULAS continua sendo 404', () => {
    // O par: normalizar não pode virar "deixar passar". Sem esta, um guard
    // que sempre devolvesse `true` passaria na prova acima — e o gate de
    // tenant estaria morto.
    const ctx = buildContext(
      { role: 'company_admin', companyId: EMPRESA },
      { companyId: OUTRA.toUpperCase() },
    );
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('permite quando a rota não tem :companyId (nada a comparar)', () => {
    const ctx = buildContext({ role: 'aluno', companyId: 'empresa-a' }, {});
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

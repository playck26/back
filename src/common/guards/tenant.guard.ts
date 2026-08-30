import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessTokenPayload } from '../types/jwt-payload.type';

/**
 * Guard de escopo de tenant reutilizável (REQ-006, SPEC-001).
 * Roda depois do JwtAuthGuard. Compara o :companyId da rota com o
 * company_id do usuário autenticado — super_admin passa sempre (não tem
 * escopo de tenant). Mismatch retorna 404, nunca 403 (SECURITY_PRIVACY.md:
 * nunca confirmar a existência de recurso de outra empresa).
 *
 * IMPORTANTE (achado de validação cruzada, 2026-08-09): este guard só
 * cobre o :companyId presente na PRÓPRIA rota. Endpoints futuros que
 * exponham um recurso de domínio pelo próprio :id (ex. GET /alunos/:id)
 * não ficam automaticamente protegidos — o service/repository correspondente
 * precisa filtrar company_id explicitamente (ver AGENTS.md, Gates
 * Obrigatórios). Este guard nunca substitui esse filtro.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user: AccessTokenPayload;
      params: Record<string, string>;
    }>();
    const user = request.user;

    if (user.role === 'super_admin') {
      return true;
    }

    const routeCompanyId = request.params?.companyId;
    if (!routeCompanyId) {
      return true;
    }

    // **`toLowerCase()`, e o `UuidCanonicoPipe` NÃO resolve isto.**
    //
    // Guard roda ANTES de pipe no ciclo do Nest: o que chega aqui é
    // `request.params` cru, com a grafia que veio da URL. O `companyId` do
    // token é canônico (sai de `usuario.companyId`/`empresa.id`, lidos do
    // Postgres), então `A000…` na rota contra `a000…` no token dava `404`
    // na PRÓPRIA empresa do gestor.
    //
    // Hoje só a rota de smoke usa este guard, então não é defeito em
    // produção — mas ele existe para ser reusado (ver a nota acima sobre
    // endpoints futuros), e reusar um gate quebrado é como o defeito
    // voltaria.
    if (routeCompanyId.toLowerCase() !== user.companyId) {
      throw new NotFoundException();
    }

    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AccessTokenPayload } from '../types/jwt-payload.type';

/**
 * Guard de role reutilizável para rotas exclusivas de company_admin
 * (MOD-003/MOD-004/MOD-005/MOD-006). Roda depois do JwtAuthGuard.
 *
 * Não faz escopo de tenant sozinho — as rotas protegidas por este guard
 * não têm :companyId na URL (o escopo vem do company_id do próprio token),
 * então cada service precisa filtrar explicitamente por
 * `user.companyId` (ver nota em AGENTS.md, Gates Obrigatórios: TenantGuard
 * só cobre :companyId de rota, nunca substitui o filtro na camada de
 * serviço/repositório).
 */
@Injectable()
export class CompanyAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AccessTokenPayload }>();

    if (request.user.role !== 'company_admin') {
      throw new ForbiddenException();
    }

    return true;
  }
}

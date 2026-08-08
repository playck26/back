import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UsuarioRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AccessTokenPayload } from '../types/jwt-payload.type';

/**
 * Guard de role para rotas que aceitam mais de uma role (SPEC-005: courts/
 * bookings passam a aceitar `company_admin` e `aluno`, cada um com escopo
 * diferente resolvido no controller/service — este guard só bloqueia role
 * fora da lista de `@Roles(...)`, não faz tenant/aluno scoping sozinho.
 * Roda depois do JwtAuthGuard. Sem `@Roles(...)` na rota, deixa passar
 * qualquer role autenticada.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesPermitidas = this.reflector.getAllAndOverride<UsuarioRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!rolesPermitidas || rolesPermitidas.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user: AccessTokenPayload }>();

    if (!rolesPermitidas.includes(request.user.role)) {
      throw new ForbiddenException();
    }

    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AccessTokenPayload } from '../types/jwt-payload.type';

/**
 * Guard de role reutilizável para rotas exclusivas de super_admin
 * (REQ-006, SPEC-002 — NFR-001: toda rota de /companies exige super_admin,
 * sem exceção). Roda depois do JwtAuthGuard.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AccessTokenPayload }>();

    if (request.user.role !== 'super_admin') {
      throw new ForbiddenException();
    }

    return true;
  }
}

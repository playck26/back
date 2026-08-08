import { SetMetadata } from '@nestjs/common';
import type { UsuarioRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

// Usado com RolesGuard para rotas que aceitam mais de uma role (ex.:
// company_admin e aluno lendo o mesmo recurso com escopo diferente) — as
// rotas exclusivas de uma única role continuam usando os guards dedicados
// (SuperAdminGuard, CompanyAdminGuard), que existiam antes desta spec.
export const Roles = (...roles: UsuarioRole[]) => SetMetadata(ROLES_KEY, roles);

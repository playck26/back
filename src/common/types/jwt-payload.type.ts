import type { UsuarioRole } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  nome: string;
  role: UsuarioRole;
  companyId: string | null;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

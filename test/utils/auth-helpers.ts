import type { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { bodyOf } from './http';
import type { PrismaMock } from './prisma-mock';

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

export const SENHA_VALIDA = 'senha-valida-123';
export const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

export async function buildUsuarioAtivo(
  overrides: Partial<{
    id: string;
    email: string;
    role: 'super_admin' | 'company_admin' | 'aluno' | 'professor';
    companyId: string | null;
  }> = {},
) {
  const senhaHash = await bcrypt.hash(SENHA_VALIDA, 12);
  return {
    id: 'u1',
    email: 'admin@empresa.demo',
    senhaHash,
    nome: 'Admin Demo',
    telefone: null,
    role: 'company_admin' as const,
    companyId: COMPANY_ID,
    status: 'ativo',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Login é o pré-requisito de quase todo teste autenticado — centralizado
// aqui pra não esquecer o mock de `empresa.findUnique` que
// `AuthService.login` consulta sempre que `usuario.companyId` não é nulo
// (AC-008), e pra não duplicar entre suítes (TEST-001, TEST-002, ...).
export async function loginAndGetTokens(
  app: INestApplication<App>,
  prisma: PrismaMock,
  usuario: Awaited<ReturnType<typeof buildUsuarioAtivo>>,
): Promise<{ accessToken: string; refreshToken: string }> {
  prisma.usuario.findUnique.mockResolvedValue(usuario);
  if (usuario.companyId) {
    prisma.empresa.findUnique.mockResolvedValue({
      id: usuario.companyId,
      status: 'ativa',
    });
  }
  prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });

  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: usuario.email, senha: SENHA_VALIDA })
    .expect(200);

  return bodyOf<LoginResponseBody>(res);
}

import {
  ConflictException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

// TEST-001 (SPEC-001): unit tests da regra de negócio de MOD-001, com
// PrismaService mockado — não depende de banco vivo (Neon ainda não
// provisionado, ver STATUS.md). Contrato HTTP fim a fim (Supertest) fica
// para quando a spec 001 fechar DoD com Neon disponível.

function buildPrismaMock() {
  return {
    usuario: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
    },
    empresa: {
      findUnique: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  } as unknown as PrismaService;
}

function buildConfigMock(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '7d',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (!value) throw new Error(`missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
}

function buildJwtMock() {
  let counter = 0;
  return {
    signAsync: jest.fn(() => Promise.resolve(`signed-token-${counter++}`)),
    verify: jest.fn(),
  } as unknown as JwtService;
}

describe('AuthService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let config: ConfigService;
  let jwt: JwtService;
  let service: AuthService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    config = buildConfigMock();
    jwt = buildJwtMock();
    service = new AuthService(prisma, jwt, config);
  });

  describe('login', () => {
    it('rejeita email inexistente com mensagem genérica (AC-002)', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.login({ email: 'x@x.com', senha: 'errada12' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejeita senha errada com a mesma mensagem genérica (AC-002)', async () => {
      const senhaHash = await bcrypt.hash('senha-certa', 12);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'x@x.com',
        senhaHash,
        nome: 'X',
        role: 'company_admin',
        companyId: 'c1',
      });

      const promise = service.login({
        email: 'x@x.com',
        senha: 'senha-errada',
      });
      await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(promise).rejects.toThrow('Credenciais inválidas');
    });

    it('rejeita login se a empresa do usuário está inativa (AC-008)', async () => {
      const senhaHash = await bcrypt.hash('senha-certa', 12);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'x@x.com',
        senhaHash,
        nome: 'X',
        role: 'company_admin',
        companyId: 'c1',
      });
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        status: 'inativa',
      });

      await expect(
        service.login({ email: 'x@x.com', senha: 'senha-certa' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('loga com sucesso e emite access/refresh token (REQ-002)', async () => {
      const senhaHash = await bcrypt.hash('senha-certa', 12);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'x@x.com',
        senhaHash,
        nome: 'X',
        role: 'company_admin',
        companyId: 'c1',
      });
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        status: 'ativa',
      });
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const result = await service.login({
        email: 'x@x.com',
        senha: 'senha-certa',
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.usuario).toEqual({
        id: 'u1',
        nome: 'X',
        email: 'x@x.com',
        role: 'company_admin',
        companyId: 'c1',
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('super_admin (sem company_id) não checa empresa', async () => {
      const senhaHash = await bcrypt.hash('senha-certa', 12);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'root@playck.com',
        senhaHash,
        nome: 'Root',
        role: 'super_admin',
        companyId: null,
      });
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      await service.login({ email: 'root@playck.com', senha: 'senha-certa' });

      expect(prisma.empresa.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('registerAluno', () => {
    const dto = {
      email: 'aluno@x.com',
      senha: 'senha-forte',
      nome: 'Aluno',
      companyId: 'c1',
    };

    it('rejeita empresa inexistente/inativa com 422', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.registerAluno(dto)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('rejeita email já cadastrado com 409 (AC-004)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        status: 'ativa',
      });
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.registerAluno(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('cria aluno vinculado à empresa (REQ-005)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        status: 'ativa',
      });
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.create as jest.Mock).mockResolvedValue({
        id: 'u2',
        email: dto.email,
        nome: dto.nome,
        role: 'aluno',
        companyId: 'c1',
      });

      const result = await service.registerAluno(dto);

      expect(result.usuario.role).toBe('aluno');
      expect(result.usuario.companyId).toBe('c1');
    });
  });

  describe('refresh', () => {
    it('rejeita token expirado/inválido na verificação de assinatura', async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('bad signature');
      });

      await expect(service.refresh('token-invalido')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rotaciona o refresh token válido e emite novos tokens', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'rt1' });
      const tokenHash = await bcrypt.hash('token-valido', 12);
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        usuarioId: 'u1',
        tokenHash,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 10_000),
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.usuario.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'x@x.com',
        nome: 'X',
        role: 'company_admin',
        companyId: 'c1',
      });
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const result = await service.refresh('token-valido');

      expect(result.accessToken).toBeDefined();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('detecta reuso sequencial de token já rotacionado e revoga toda a sessão (REQ-003, AC-003)', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'rt1' });
      const tokenHash = await bcrypt.hash('token-reusado', 12);
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        usuarioId: 'u1',
        tokenHash,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 10_000),
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      await expect(service.refresh('token-reusado')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'rt1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('perde a corrida de rotação concorrente (mesmo token, requisições simultâneas) e é tratado como reuso', async () => {
      // Achado da validação cruzada: 2 requisições simultâneas com o
      // mesmo refresh token não podem mais as duas emitir tokens novos.
      // A claim atômica (updateMany WHERE revokedAt: null) garante que só
      // uma "ganha" (count=1); a outra recebe count=0 mesmo que, no
      // momento em que ela leu a linha, revokedAt ainda estivesse null —
      // simulado aqui mockando o resultado da claim como perdedor direto.
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'rt1' });
      const tokenHash = await bcrypt.hash('token-corrida', 12);
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        usuarioId: 'u1',
        tokenHash,
        revokedAt: null, // ainda null no momento da leitura desta requisição
        expiresAt: new Date(Date.now() + 10_000),
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({
        count: 0, // mas a claim atômica já foi ganha pela requisição concorrente
      });

      await expect(service.refresh('token-corrida')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenNthCalledWith(2, {
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('token expirado e nunca usado por ninguém não revoga as outras sessões do usuário', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'rt1' });
      const tokenHash = await bcrypt.hash('token-expirado', 12);
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        usuarioId: 'u1',
        tokenHash,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 10_000),
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      await expect(service.refresh('token-expirado')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // Só a tentativa de claim — nunca a revogação de toda a sessão.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('logout', () => {
    it('revoga todos os refresh tokens ativos do usuário quando não há cookie (REQ-004)', async () => {
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

      await service.logout('u1');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});

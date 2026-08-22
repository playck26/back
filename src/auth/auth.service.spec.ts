import {
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StudentsService } from '../people/students.service';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

// TEST-001 (SPEC-001): unit tests da regra de negócio de MOD-001, com
// PrismaService mockado — não depende de banco vivo (Neon ainda não
// provisionado, ver STATUS.md). Contrato HTTP fim a fim (Supertest) fica
// para quando a spec 001 fechar DoD com Neon disponível.

interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  aluno: { create: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    aluno: { create: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const prisma = {
    usuario: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
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
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
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
    verifyAsync: jest.fn(),
  } as unknown as JwtService;
}

describe('AuthService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let config: ConfigService;
  let jwt: JwtService;
  let students: StudentsService;
  let service: AuthService;

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    tx = built.tx;
    config = buildConfigMock();
    jwt = buildJwtMock();
    // SPEC-009/REQ-007: MOD-001 delega a criação do perfil de aluno a
    // MOD-003 — o mock prova que a delegação acontece, e que MOD-001 não
    // toca `tx.aluno` direto.
    students = {
      criarPerfilDeAluno: jest.fn().mockResolvedValue({ id: 'a1' }),
    } as unknown as StudentsService;
    service = new AuthService(prisma, students, jwt, config);
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
        // SPEC-009/AC-008: o frontend usa este campo para decidir se manda
        // a pessoa para a tela de primeiro acesso.
        senhaTemporaria: false,
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
      // SPEC-009/REQ-001: a empresa vem pelo slug do link público, não
      // pelo UUID interno.
      empresaSlug: 'smart-tennis',
    };
    const EMPRESA_OK = {
      id: 'c1',
      status: 'ativa',
      permiteAutoCadastro: true,
    };

    // SPEC-009/REQ-011 (AC-021): os quatro modos de falha precisam ser
    // indistinguíveis. Antes, empresa inválida devolvia 422 com uma
    // mensagem e e-mail duplicado devolvia 409 com outra — o que fazia
    // deste endpoint aberto um verificador de existência de tenant e de
    // conta.
    const casosDeFalha: [string, () => void][] = [
      [
        'slug inexistente',
        () => {
          (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
          (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
        },
      ],
      [
        'empresa inativa',
        () => {
          (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
            ...EMPRESA_OK,
            status: 'inativa',
          });
          (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
        },
      ],
      [
        'auto-cadastro desligado',
        () => {
          (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
            ...EMPRESA_OK,
            permiteAutoCadastro: false,
          });
          (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
        },
      ],
      [
        'e-mail já cadastrado',
        () => {
          (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(
            EMPRESA_OK,
          );
          (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
            id: 'existing',
          });
        },
      ],
    ];

    it.each(casosDeFalha)(
      'AC-021: %s devolve 422 genérico, sempre a mesma mensagem',
      async (_caso, preparar) => {
        preparar();

        const erro = (await service
          .registerAluno(dto)
          .catch((e: Error) => e)) as Error;

        expect(erro).toBeInstanceOf(UnprocessableEntityException);
        expect(erro.message).toBe(
          'Não foi possível concluir o cadastro com esses dados.',
        );
        expect(tx.usuario.create).not.toHaveBeenCalled();
      },
    );

    it('cria usuario + perfil aluno numa transação (REQ-005)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(EMPRESA_OK);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({
        id: 'u2',
        email: dto.email,
        nome: dto.nome,
        role: 'aluno',
        companyId: 'c1',
      });
      tx.aluno.create.mockResolvedValue({
        id: 'a1',
        usuarioId: 'u2',
        companyId: 'c1',
      });

      const result = await service.registerAluno(dto);

      expect(result.usuario.role).toBe('aluno');
      expect(result.usuario.companyId).toBe('c1');
      // SPEC-009/REQ-007 (AC-013): MOD-001 delega a MOD-003 e **não** toca
      // a tabela `alunos` direto. O `tx` é repassado porque conta e perfil
      // nascem na mesma transação.
      expect(tx.aluno.create).not.toHaveBeenCalled();
      expect(students.criarPerfilDeAluno).toHaveBeenCalledWith(tx, {
        usuarioId: 'u2',
        companyId: 'c1',
        // Auto-cadastro público nasce pendente de aprovação (REQ-008).
        vinculo: 'pendente',
      });
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

  // SPEC-009/AC-020 — logout deixou de exigir access token válido; a
  // identificação vem do cookie de refresh, com o Bearer como alternativa.
  describe('logout', () => {
    it('revoga a sessão do refresh token do cookie', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'jti-1' });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

      await service.logout({ refreshTokenRaw: 'refresh-valido' });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'jti-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('cai no Bearer e revoga todas as sessões quando não há cookie', async () => {
      (jwt.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'u1' });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

      await service.logout({ accessTokenRaw: 'access-valido' });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('é idempotente sem credencial nenhuma — não revoga nada nem vaza erro', async () => {
      await expect(service.logout({})).resolves.toBeUndefined();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // SPEC-009 — senha temporária (INV-008, AC-009, AC-019)
  // ===================================================================

  describe('senha temporária (SPEC-009)', () => {
    const usuarioComSenhaTemporariaVencida = (senhaHash: string) => ({
      id: 'u1',
      email: 'aluno@x.com',
      nome: 'Aluno',
      role: 'aluno' as const,
      companyId: 'c1',
      senhaHash,
      senhaTemporaria: true,
      senhaTemporariaExpiraEm: new Date(Date.now() - 60_000),
    });

    it('login recusa senha temporária vencida e derruba as sessões (ADR-013)', async () => {
      const senhaHash = await bcrypt.hash('pck-ABC123', 12);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(
        usuarioComSenhaTemporariaVencida(senhaHash),
      );
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        status: 'ativa',
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({});

      await expect(
        service.login({ email: 'aluno@x.com', senha: 'pck-ABC123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    // Este é o furo que a 1ª validação cruzada encontrou (ACHADO-002): sem
    // a checagem no refresh, uma sessão aberta antes do vencimento se
    // renovaria para sempre e a validade de 7 dias não valeria nada.
    it('refresh recusa senha temporária vencida em vez de renovar a sessão (AC-019)', async () => {
      (jwt.verify as jest.Mock).mockReturnValue({ sub: 'u1', jti: 'jti-1' });
      const tokenHash = await bcrypt.hash('refresh-valido', 12);
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'jti-1',
        usuarioId: 'u1',
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.usuario.findUniqueOrThrow as jest.Mock).mockResolvedValue(
        usuarioComSenhaTemporariaVencida('nao-importa'),
      );

      await expect(service.refresh('refresh-valido')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('trocarSenha exige a senha atual correta', async () => {
      const senhaHash = await bcrypt.hash('pck-ABC123', 12);
      (prisma.usuario.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...usuarioComSenhaTemporariaVencida(senhaHash),
        senhaTemporariaExpiraEm: new Date(Date.now() + 86_400_000),
      });

      await expect(
        service.trocarSenha('u1', {
          senhaAtual: 'chute-errado',
          novaSenha: 'senha-nova-forte',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('trocarSenha limpa a flag, revoga sessões antigas e devolve par novo (AC-009)', async () => {
      const senhaHash = await bcrypt.hash('pck-ABC123', 12);
      (prisma.usuario.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...usuarioComSenhaTemporariaVencida(senhaHash),
        senhaTemporariaExpiraEm: new Date(Date.now() + 86_400_000),
      });
      tx.usuario.update.mockResolvedValue({});
      tx.refreshToken.updateMany.mockResolvedValue({});
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const tokens = await service.trocarSenha('u1', {
        senhaAtual: 'pck-ABC123',
        novaSenha: 'senha-nova-forte',
      });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({
          senhaTemporaria: false,
          senhaTemporariaExpiraEm: null,
        }),
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
    });
  });
});

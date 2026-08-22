import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from './students.service';
import { gerarSenhaTemporaria } from '../common/utils/senha-temporaria';

// TEST-003 (SPEC-003): unit tests de MOD-003 (alunos) com Prisma mockado.

interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  aluno: { create: jest.Mock; update: jest.Mock };
  // SPEC-009: `regenerarSenhaTemporaria` revoga sessões na mesma transação.
  refreshToken: { updateMany: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    aluno: { create: jest.fn(), update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const prisma = {
    usuario: { findUnique: jest.fn() },
    aluno: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ocupacaoQuadra: { count: jest.fn() },
    turmaAluno: { count: jest.fn() },
    nivel: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

describe('StudentsService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let service: StudentsService;

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    tx = built.tx;
    service = new StudentsService(prisma);
  });

  describe('list', () => {
    it('escopa por company_id e mapeia dado de usuario+aluno (REQ-001, REQ-006)', async () => {
      (prisma.aluno.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'a1',
          nivelId: null,
          status: 'ativo',
          usuario: { nome: 'Aluno 1', email: 'aluno1@x.com', telefone: null },
        },
      ]);
      (prisma.aluno.count as jest.Mock).mockResolvedValue(1);

      const result = await service.list('c1', { page: 1, pageSize: 20 });

      expect(prisma.aluno.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { companyId: 'c1' } }),
      );
      expect(result.data).toEqual([
        {
          id: 'a1',
          nome: 'Aluno 1',
          email: 'aluno1@x.com',
          telefone: null,
          nivelId: null,
          status: 'ativo',
        },
      ]);
    });
  });

  describe('create', () => {
    const dto = { nome: 'Novo Aluno', email: 'novo@x.com' };

    it('rejeita email já cadastrado com 409', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejeita nivelId de outra empresa com 404', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.nivel.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create('c1', { ...dto, nivelId: 'n-outra-empresa' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cria usuario (role aluno, senha aleatória) + perfil aluno numa transação', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: dto.nome, email: dto.email, telefone: null },
      });

      const result = await service.create('c1', dto);

      expect(tx.usuario.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: dto.email,
            role: 'aluno',
            companyId: 'c1',
          }),
        }),
      );
      expect(tx.aluno.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usuarioId: 'u1', companyId: 'c1' }),
        }),
      );
      expect(result.email).toBe(dto.email);
      expect(JSON.stringify(result)).not.toMatch(/senhaHash|hash/i);
    });
  });

  describe('findOne', () => {
    it('lança 404 quando não existe ou é de outra empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('c1', 'a1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.aluno.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1', companyId: 'c1' } }),
      );
    });
  });

  describe('update', () => {
    it('propaga 404 se o aluno não existe na empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('c1', 'a1', { nome: 'Novo' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('atualiza usuario e aluno na mesma transação', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      tx.aluno.update.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: 'Atualizado', email: 'x@x.com', telefone: null },
      });

      const result = await service.update('c1', 'a1', { nome: 'Atualizado' });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { nome: 'Atualizado', telefone: undefined },
      });
      expect(result.nome).toBe('Atualizado');
    });
  });

  // =====================================================================
  // SPEC-009/REQ-008, REQ-009 — vínculo do aluno (INV-010)
  // =====================================================================

  describe('vínculo (SPEC-009)', () => {
    const alunoBase = {
      id: 'a1',
      companyId: 'c1',
      usuario: { nome: 'Fulano', email: 'f@x.com', telefone: null },
      status: 'ativo',
      nivelId: null,
      createdAt: new Date(),
    };

    it('garantirVinculoAprovado bloqueia pendente com 403 VINCULO_PENDENTE', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'pendente' }),
      ).toThrow(ForbiddenException);
    });

    it('garantirVinculoAprovado bloqueia recusado também', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'recusado' }),
      ).toThrow(ForbiddenException);
    });

    it('garantirVinculoAprovado deixa passar aprovado', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'aprovado' }),
      ).not.toThrow();
    });

    it('aprovar move pendente para aprovado (AC-015)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'pendente',
      });
      (prisma.aluno.update as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await service.decidirVinculo('c1', 'a1', 'aprovado');

      expect(prisma.aluno.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { vinculo: 'aprovado' },
        include: { usuario: true },
      });
    });

    it('aprovar duas vezes é idempotente e não escreve de novo (AC-015)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await service.decidirVinculo('c1', 'a1', 'aprovado');

      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    // Recusar aluno já aprovado seria um jeito silencioso de desligar
    // alguém que já opera — isso é `status = inativo`, outra operação.
    it('recusar aluno já aprovado retorna 409, não desliga por vias transversas', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await expect(
        service.decidirVinculo('c1', 'a1', 'recusado'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    it('recusar com reserva pendurada retorna 409 em vez de cancelar sozinho', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'pendente',
      });
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(2);
      (prisma.turmaAluno.count as jest.Mock).mockResolvedValue(0);

      await expect(
        service.decidirVinculo('c1', 'a1', 'recusado'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    it('exigirVinculoAprovado carrega do banco e bloqueia pendente (MOD-005)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        vinculo: 'pendente',
      });

      await expect(
        service.exigirVinculoAprovado('c1', 'a1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // =====================================================================
  // SPEC-009/REQ-003, REQ-005 — senha temporária (AC-006, AC-007, AC-010)
  // =====================================================================

  describe('senha temporária (SPEC-009)', () => {
    const alunoCriado = {
      id: 'a1',
      nivelId: null,
      status: 'ativo',
      usuarioId: 'u1',
      usuario: { nome: 'Fulano', email: 'f@x.com', telefone: null },
    };

    it('AC-006: create devolve a senha temporária e marca a conta', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue(alunoCriado);

      const res = await service.create('c1', {
        nome: 'Fulano',
        email: 'f@x.com',
      });

      // Legível de propósito: vai ser lida em voz alta ou copiada de um
      // print, sem os pares que se confundem (0/O, 1/I/L, 5/S, 2/Z, 8/B).
      expect(res.senhaTemporaria).toMatch(
        /^pck-[ACDEFGHJKMNPQRTUVWXY34679]{6}$/,
      );

      const [dadosUsuario] = tx.usuario.create.mock.calls[0] as [
        { data: { senhaTemporaria: boolean; senhaTemporariaExpiraEm: Date } },
      ];
      expect(dadosUsuario.data.senhaTemporaria).toBe(true);
      const dias =
        (dadosUsuario.data.senhaTemporariaExpiraEm.getTime() - Date.now()) /
        86_400_000;
      expect(dias).toBeGreaterThan(6.9);
      expect(dias).toBeLessThan(7.1);
    });

    it('AC-006: a senha vai só na resposta, nunca em claro no banco', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue(alunoCriado);

      const res = await service.create('c1', {
        nome: 'Fulano',
        email: 'f@x.com',
      });

      const [dados] = tx.usuario.create.mock.calls[0] as [
        { data: { senhaHash: string } },
      ];
      expect(dados.data.senhaHash).not.toBe(res.senhaTemporaria);
      expect(dados.data.senhaHash.startsWith('$2')).toBe(true);
    });

    // AC-007: se a senha vazasse por findOne/list, o "uma única vez" da
    // spec seria decorativo.
    it('AC-007: findOne não devolve senha temporária', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(alunoCriado);

      const res = await service.findOne('c1', 'a1');

      expect(res).not.toHaveProperty('senhaTemporaria');
    });

    it('AC-010: regenerar devolve senha nova, remarca a conta e derruba sessões', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(alunoCriado);
      tx.usuario.update.mockResolvedValue({});
      tx.refreshToken.updateMany.mockResolvedValue({});

      const res = await service.regenerarSenhaTemporaria('c1', 'a1');

      expect(res.senhaTemporaria).toMatch(/^pck-/);
      const [upd] = tx.usuario.update.mock.calls[0] as [
        { where: { id: string }; data: { senhaTemporaria: boolean } },
      ];
      expect(upd.where.id).toBe('u1');
      expect(upd.data.senhaTemporaria).toBe(true);
      // Se a senha anterior vazou, sessão antiga viva anularia o gesto.
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('AC-011: regenerar aluno de outra empresa retorna 404', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.regenerarSenhaTemporaria('c1', 'a-de-outra-empresa'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duas senhas geradas em sequência não se repetem', () => {
      const senhas = new Set(
        Array.from({ length: 20 }, () => gerarSenhaTemporaria()),
      );
      expect(senhas.size).toBe(20);
    });
  });
});

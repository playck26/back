import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from './students.service';

// TEST-003 (SPEC-003): unit tests de MOD-003 (alunos) com Prisma mockado.

interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  aluno: { create: jest.Mock; update: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    aluno: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    usuario: { findUnique: jest.fn() },
    aluno: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
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
});

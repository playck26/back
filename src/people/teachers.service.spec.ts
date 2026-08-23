import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeachersService } from './teachers.service';

interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  professor: { update: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    professor: { update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const prisma = {
    professor: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    usuario: { findUnique: jest.fn() },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

describe('TeachersService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let service: TeachersService;

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    tx = built.tx;
    service = new TeachersService(prisma);
  });

  it('lista escopado por company_id', async () => {
    (prisma.professor.findMany as jest.Mock).mockResolvedValue([{ id: 'p1' }]);
    (prisma.professor.count as jest.Mock).mockResolvedValue(1);

    const result = await service.list('c1', { page: 1, pageSize: 20 });

    expect(prisma.professor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1' } }),
    );
    expect(result.total).toBe(1);
  });

  it('cria professor vinculado à empresa', async () => {
    (prisma.professor.create as jest.Mock).mockResolvedValue({
      id: 'p1',
      nome: 'Prof',
    });

    await service.create('c1', { nome: 'Prof' });

    expect(prisma.professor.create).toHaveBeenCalledWith({
      data: {
        companyId: 'c1',
        nome: 'Prof',
        telefone: undefined,
        email: undefined,
      },
    });
  });

  it('findOne lança 404 cross-tenant', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.findOne('c1', 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('update propaga 404 antes de escrever', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.update('c1', 'p1', { nome: 'Novo' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.professor.update).not.toHaveBeenCalled();
  });

  // =====================================================================
  // SPEC-013 — acesso do professor
  // =====================================================================
  describe('gerarAcesso', () => {
    const ficha = {
      id: 'p1',
      companyId: 'c1',
      nome: 'Professor Um',
      telefone: null,
      email: 'prof@escola.demo',
      status: 'ativo',
      usuarioId: null,
    };

    it('cria a conta com senha temporaria e devolve a senha uma vez', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(ficha);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u9' });
      tx.professor.update.mockResolvedValue({ ...ficha, usuarioId: 'u9' });

      const res = await service.gerarAcesso('c1', 'p1');

      // Reusa o desenho da SPEC-009 inteiro: prefixo reconhecivel, conta
      // travada por INV-008 ate a troca.
      expect(res.senhaTemporaria).toMatch(/^pck-/);
      expect(tx.usuario.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: 'professor',
            senhaTemporaria: true,
            companyId: 'c1',
          }),
        }),
      );
      expect(tx.professor.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { usuarioId: 'u9' },
      });
    });

    // AC-003 — o caso real e o professor ter perdido o papel onde anotou.
    it('chamada repetida rotaciona a senha em vez de criar segunda conta', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue({
        ...ficha,
        usuarioId: 'u9',
      });

      const res = await service.gerarAcesso('c1', 'p1');

      expect(tx.usuario.create).not.toHaveBeenCalled();
      expect(res.senhaTemporaria).toMatch(/^pck-/);
      // Pedir senha nova sem derrubar a antiga daria duas credenciais vivas.
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u9', revokedAt: null },
        data: { revokedAt: expect.any(Date) as Date },
      });
    });

    // AC-002 — o e-mail e o login; sem ele nao ha o que criar.
    it('recusa sem e-mail, dizendo o que falta', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue({
        ...ficha,
        email: null,
      });

      await expect(service.gerarAcesso('c1', 'p1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    // AC-004 / LIM-001 — uma pessoa, uma conta, um papel.
    it('recusa com 409 quando o e-mail ja e de outra conta', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(ficha);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({ id: 'u1' });

      await expect(service.gerarAcesso('c1', 'p1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('nao vaza professor de outra empresa', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.gerarAcesso('c2', 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // A divida que a TASK-000 deixou anotada em `teachers.service.ts`: agora
  // que o professor tem conta, inativar a ficha tem de revogar o acesso.
  describe('update — propagacao de status (INV-013)', () => {
    it('inativar professor com conta propaga e derruba as sessoes', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue({
        id: 'p1',
        companyId: 'c1',
        usuarioId: 'u9',
      });
      tx.professor.update.mockResolvedValue({ id: 'p1', status: 'inativo' });

      await service.update('c1', 'p1', { status: 'inativo' });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u9' },
        data: { status: 'inativo' },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    // A maioria dos professores nunca vai ter conta. Inativar a ficha deles
    // continua sendo so isso, sem transacao inutil sobre `usuarios`.
    it('professor sem conta: nada a revogar', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue({
        id: 'p1',
        companyId: 'c1',
        usuarioId: null,
      });
      tx.professor.update.mockResolvedValue({ id: 'p1', status: 'inativo' });

      await service.update('c1', 'p1', { status: 'inativo' });

      expect(tx.usuario.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});

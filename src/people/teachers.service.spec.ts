import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeachersService } from './teachers.service';

function buildPrismaMock() {
  return {
    professor: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe('TeachersService', () => {
  let prisma: PrismaService;
  let service: TeachersService;

  beforeEach(() => {
    prisma = buildPrismaMock();
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
});

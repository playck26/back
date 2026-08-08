import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LevelsService } from './levels.service';

function buildPrismaMock() {
  return {
    nivel: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    aluno: {
      count: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe('LevelsService', () => {
  let prisma: PrismaService;
  let service: LevelsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new LevelsService(prisma);
  });

  describe('create', () => {
    it('rejeita nome duplicado na mesma empresa com 409 (AC-003)', async () => {
      (prisma.nivel.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(
        service.create('c1', { nome: 'Iniciante', ordem: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cria nível quando o nome não colide', async () => {
      (prisma.nivel.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.nivel.create as jest.Mock).mockResolvedValue({
        id: 'n1',
        nome: 'Iniciante',
        ordem: 1,
      });

      const result = await service.create('c1', {
        nome: 'Iniciante',
        ordem: 1,
      });

      expect(result.id).toBe('n1');
    });
  });

  describe('remove', () => {
    it('lança 404 se o nível não existe na empresa', async () => {
      (prisma.nivel.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.remove('c1', 'n1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejeita remoção com 422 quando em uso por aluno (CON-003.6)', async () => {
      (prisma.nivel.findFirst as jest.Mock).mockResolvedValue({ id: 'n1' });
      (prisma.aluno.count as jest.Mock).mockResolvedValue(2);

      await expect(service.remove('c1', 'n1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.nivel.delete).not.toHaveBeenCalled();
    });

    it('remove quando não está em uso', async () => {
      (prisma.nivel.findFirst as jest.Mock).mockResolvedValue({ id: 'n1' });
      (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
      (prisma.nivel.delete as jest.Mock).mockResolvedValue({});

      await service.remove('c1', 'n1');

      expect(prisma.nivel.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    });
  });
});

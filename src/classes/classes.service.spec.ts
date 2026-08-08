import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CourtsService } from '../courts/courts.service';
import {
  gerarDatasSemanaisFuturas,
  parseTimeOnly,
} from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

// TEST-004 (SPEC-003, fatia de turmas): unit tests de MOD-004 com Prisma e
// CourtsService (MOD-005) mockados. A garantia física de INV-001 (sem
// overbooking) já é provada por TEST-005/FIT-001 em MOD-005 — aqui só
// verificamos que MOD-004 chama o método público certo e propaga o 409.

interface TxMock {
  turma: { create: jest.Mock; update: jest.Mock };
  $queryRaw: jest.Mock;
  aluno: { findFirst: jest.Mock };
  turmaAluno: { findFirst: jest.Mock; count: jest.Mock; create: jest.Mock };
}

function buildMocks() {
  const tx: TxMock = {
    turma: { create: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
    aluno: { findFirst: jest.fn() },
    turmaAluno: { findFirst: jest.fn(), count: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    turma: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    quadra: { findFirst: jest.fn() },
    nivel: { findFirst: jest.fn() },
    professor: { findFirst: jest.fn() },
    turmaAluno: { findFirst: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  const courtsService = {
    registerClassOccupancy: jest.fn(),
    cancelFutureClassOccupancies: jest.fn(),
  };
  return {
    prisma: prisma as unknown as PrismaService,
    tx,
    courtsService: courtsService as unknown as CourtsService,
    courtsServiceMock: courtsService,
  };
}

const QUADRA_ATIVA = { id: 'q1', companyId: 'c1' };

describe('ClassesService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let courtsService: CourtsService;
  let courtsServiceMock: {
    registerClassOccupancy: jest.Mock;
    cancelFutureClassOccupancies: jest.Mock;
  };
  let service: ClassesService;

  const dto = {
    nome: 'Turma A',
    quadraId: 'q1',
    diaSemana: 2,
    horaInicio: '14:00',
    horaFim: '15:00',
    capacidade: 4,
  };

  beforeEach(() => {
    const built = buildMocks();
    prisma = built.prisma;
    tx = built.tx;
    courtsService = built.courtsService;
    courtsServiceMock = built.courtsServiceMock;
    service = new ClassesService(prisma, courtsService);
  });

  describe('create', () => {
    it('rejeita horaFim <= horaInicio com 422', async () => {
      await expect(
        service.create('c1', { ...dto, horaInicio: '15:00', horaFim: '14:00' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lança 404 se a quadra não é da empresa', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cria turma e gera 8 ocorrências futuras via registerClassOccupancy (REQ-002/003, NFR-002)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      tx.turma.create.mockResolvedValue({
        id: 't1',
        companyId: 'c1',
        nome: dto.nome,
        nivelId: null,
        professorId: null,
        quadraId: 'q1',
        diaSemana: 2,
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
        capacidade: 4,
        status: 'ativa',
      });

      const result = await service.create('c1', dto);

      const ocorrenciasEsperadas = gerarDatasSemanaisFuturas(dto.diaSemana).map(
        (data) => ({
          data,
          horaInicio: parseTimeOnly(dto.horaInicio),
          horaFim: parseTimeOnly(dto.horaFim),
        }),
      );
      expect(ocorrenciasEsperadas).toHaveLength(8);
      expect(courtsServiceMock.registerClassOccupancy).toHaveBeenCalledWith(
        tx,
        'c1',
        'q1',
        't1',
        ocorrenciasEsperadas,
      );
      expect(result.id).toBe('t1');
      expect(result.alunosAlocados).toBe(0);
    });

    it('propaga o 409 de registerClassOccupancy e não retorna turma (AC-001, NFR-001)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      tx.turma.create.mockResolvedValue({ id: 't1' });
      courtsServiceMock.registerClassOccupancy.mockRejectedValue(
        new ConflictException({
          message:
            'Conflito de horário com ocupação existente na quadra (INV-001)',
          conflicts: [{ ocupacaoId: 'o1', origemTipo: 'AVULSO' }],
        }),
      );

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    const existente = {
      id: 't1',
      companyId: 'c1',
      quadraId: 'q1',
      diaSemana: 2,
      horaInicio: new Date('1970-01-01T14:00:00.000Z'),
      horaFim: new Date('1970-01-01T15:00:00.000Z'),
    };

    it('lança 404 se a turma não é da empresa', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('c1', 't1', { nome: 'Nova' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('atualização sem mudança de horário não regenera ocupações', async () => {
      (prisma.turma.findFirst as jest.Mock)
        .mockResolvedValueOnce(existente) // check de existência
        .mockResolvedValueOnce({
          // findOne no final do update
          ...existente,
          nome: 'Nova',
          nivelId: null,
          professorId: null,
          capacidade: 4,
          status: 'ativa',
          alunos: [],
          _count: { alunos: 0 },
        });
      tx.turma.update.mockResolvedValue({ id: 't1' });

      await service.update('c1', 't1', { nome: 'Nova' });

      expect(
        courtsServiceMock.cancelFutureClassOccupancies,
      ).not.toHaveBeenCalled();
      expect(courtsServiceMock.registerClassOccupancy).not.toHaveBeenCalled();
    });

    it('mudança de horário cancela ocupações futuras e gera novas (NFR-001)', async () => {
      (prisma.turma.findFirst as jest.Mock)
        .mockResolvedValueOnce(existente)
        .mockResolvedValueOnce({
          ...existente,
          nome: 'Turma A',
          nivelId: null,
          professorId: null,
          capacidade: 4,
          status: 'ativa',
          alunos: [],
          _count: { alunos: 0 },
        });
      tx.turma.update.mockResolvedValue({ id: 't1' });
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      await service.update('c1', 't1', {
        horaInicio: '16:00',
        horaFim: '17:00',
      });

      expect(
        courtsServiceMock.cancelFutureClassOccupancies,
      ).toHaveBeenCalledWith(tx, 'c1', 't1', expect.any(Date));
      expect(courtsServiceMock.registerClassOccupancy).toHaveBeenCalledWith(
        tx,
        'c1',
        'q1',
        't1',
        expect.any(Array),
      );
    });
  });

  describe('allocateStudent', () => {
    it('lança 404 se a turma não existe na empresa', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(
        service.allocateStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lança 404 se o aluno não existe na empresa', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue(null);

      await expect(
        service.allocateStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('re-adicionar o mesmo aluno é idempotente (não recria)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a1' });
      tx.turmaAluno.findFirst.mockResolvedValue({
        id: 'ta1',
        turmaId: 't1',
        alunoId: 'a1',
      });

      const result = await service.allocateStudent('c1', 't1', 'a1');

      expect(tx.turmaAluno.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'ta1', turmaId: 't1', alunoId: 'a1' });
    });

    it('rejeita alocar o N+1-ésimo aluno numa turma de capacidade N com 409 (AC-002, INV-003)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a3' });
      tx.turmaAluno.findFirst.mockResolvedValue(null);
      tx.turmaAluno.count.mockResolvedValue(2);

      await expect(
        service.allocateStudent('c1', 't1', 'a3'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.turmaAluno.create).not.toHaveBeenCalled();
    });

    it('aloca aluno quando há vaga disponível', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a1' });
      tx.turmaAluno.findFirst.mockResolvedValue(null);
      tx.turmaAluno.count.mockResolvedValue(1);
      tx.turmaAluno.create.mockResolvedValue({
        id: 'ta1',
        turmaId: 't1',
        alunoId: 'a1',
      });

      const result = await service.allocateStudent('c1', 't1', 'a1');

      expect(tx.turmaAluno.create).toHaveBeenCalledWith({
        data: { turmaId: 't1', alunoId: 'a1' },
      });
      expect(result).toEqual({ id: 'ta1', turmaId: 't1', alunoId: 'a1' });
    });
  });

  describe('removeStudent', () => {
    it('lança 404 se a turma não é da empresa', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lança 404 se o aluno não está alocado na turma', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
      (prisma.turmaAluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove a alocação (REQ-005)', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
      (prisma.turmaAluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'ta1',
      });

      await service.removeStudent('c1', 't1', 'a1');

      expect(prisma.turmaAluno.delete).toHaveBeenCalledWith({
        where: { id: 'ta1' },
      });
    });
  });
});

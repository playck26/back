import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

// TEST-007 (SPEC-004): unit tests de MOD-007 com Prisma mockado — MOD-007
// não escreve nada, só agrega leitura de MOD-003/004/005 (somente-leitura,
// TARGET_ARCHITECTURE.md seção 6).

function buildPrismaMock() {
  return {
    aluno: { count: jest.fn() },
    turma: { findMany: jest.fn() },
    quadra: { count: jest.fn() },
    ocupacaoQuadra: { findMany: jest.fn() },
  } as unknown as PrismaService;
}

describe('DashboardService', () => {
  let prisma: PrismaService;
  let service: DashboardService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardService(prisma);
  });

  it('escopa toda leitura por company_id (REQ-006)', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.count as jest.Mock).mockResolvedValue(0);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);

    await service.summary('c1', {});

    expect(prisma.aluno.count).toHaveBeenCalledWith({
      where: { companyId: 'c1', status: 'ativo' },
    });
    expect(prisma.turma.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', status: 'ativa' } }),
    );
    expect(prisma.quadra.count).toHaveBeenCalledWith({
      where: { companyId: 'c1', status: 'ativa' },
    });
    expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'c1',
          statusPagamento: { not: 'cancelado' },
          quadra: { status: 'ativa' },
        }),
      }),
    );
  });

  it('retorna zeros quando não há turmas/quadras ativas (sem divisão por zero)', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(5);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.count as jest.Mock).mockResolvedValue(0);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.summary('c1', {});

    expect(result).toEqual({
      alunosAtivos: 5,
      ocupacaoTurmasPct: 0,
      ocupacaoQuadrasPct: 0,
    });
  });

  it('calcula ocupacaoTurmasPct como alocados sobre capacidade total das turmas ativas', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([
      { capacidade: 4, _count: { alunos: 2 } },
      { capacidade: 6, _count: { alunos: 3 } },
    ]);
    (prisma.quadra.count as jest.Mock).mockResolvedValue(0);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.summary('c1', {});

    // 5 alocados / 10 de capacidade total = 50%
    expect(result.ocupacaoTurmasPct).toBe(50);
  });

  it('calcula ocupacaoQuadrasPct somando horas de origem TURMA e AVULSO (AC-002, ADR-009)', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.count as jest.Mock).mockResolvedValue(1);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
      {
        horaInicio: new Date('1970-01-01T09:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
      },
      {
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
      },
    ]);

    const result = await service.summary('c1', { periodo: '2026-09' });

    // 2 horas ocupadas / (1 quadra * 30 dias * 16h de expediente) = 480h
    expect(result.ocupacaoQuadrasPct).toBe(Math.round((2 / 480) * 100));
  });

  it('resolve o período (query com dias no mês) a partir de `periodo` no formato AAAA-MM', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.count as jest.Mock).mockResolvedValue(1);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);

    await service.summary('c1', { periodo: '2026-02' });

    expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          data: {
            gte: new Date('2026-02-01T00:00:00.000Z'),
            lte: new Date('2026-02-28T00:00:00.000Z'),
          },
        }),
      }),
    );
  });
});

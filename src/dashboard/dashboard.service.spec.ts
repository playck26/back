import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

// TEST-007 (SPEC-004): unit tests de MOD-007 com Prisma mockado — MOD-007
// não escreve nada, só agrega leitura de MOD-003/004/005 (somente-leitura,
// TARGET_ARCHITECTURE.md seção 6).

function buildPrismaMock() {
  return {
    aluno: { count: jest.fn() },
    turma: { findMany: jest.fn() },
    // SPEC-010/REQ-009: o denominador do KPI passou a depender do horário
    // de cada quadra, então precisamos dos ids e das regras semanais.
    quadra: { findMany: jest.fn() },
    ocupacaoQuadra: { findMany: jest.fn() },
    horarioFuncionamento: { findMany: jest.fn() },
  } as unknown as PrismaService;
}

/**
 * SPEC-010: 6h–22h nos 7 dias é exatamente o que as constantes produziam
 * antes da spec — os testes existentes continuam descrevendo o mesmo
 * comportamento, e a mudança de denominador não os reescreve.
 */
function horarioPadraoDaEmpresa() {
  return Array.from({ length: 7 }, (_, diaSemana) => ({
    quadraId: null,
    diaSemana,
    fechado: false,
    horaInicio: new Date('1970-01-01T06:00:00.000Z'),
    horaFim: new Date('1970-01-01T22:00:00.000Z'),
  }));
}

describe('DashboardService', () => {
  let prisma: PrismaService;
  let service: DashboardService;

  const mockHorarioPadrao = () =>
    (prisma.horarioFuncionamento.findMany as jest.Mock).mockResolvedValue(
      horarioPadraoDaEmpresa(),
    );

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new DashboardService(prisma);
  });

  it('escopa toda leitura por company_id (REQ-006)', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
    mockHorarioPadrao();

    await service.summary('c1', {});

    expect(prisma.aluno.count).toHaveBeenCalledWith({
      where: { companyId: 'c1', status: 'ativo', vinculo: 'aprovado' },
    });
    expect(prisma.turma.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', status: 'ativa' } }),
    );
    expect(prisma.quadra.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'c1', status: 'ativa' },
      }),
    );
    // SPEC-010/NFR-003: uma consulta traz todas as regras semanais da
    // empresa — o denominador é somado em memória, sem N+1 por quadra/dia.
    expect(prisma.horarioFuncionamento.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.horarioFuncionamento.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1' } }),
    );
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
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
    mockHorarioPadrao();

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
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
    mockHorarioPadrao();

    const result = await service.summary('c1', {});

    // 5 alocados / 10 de capacidade total = 50%
    expect(result.ocupacaoTurmasPct).toBe(50);
  });

  it('calcula ocupacaoQuadrasPct somando horas de origem TURMA e AVULSO (AC-002, ADR-009)', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([{ id: 'q1' }]);
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
    mockHorarioPadrao();

    const result = await service.summary('c1', { periodo: '2026-09' });

    // 2 horas ocupadas / (1 quadra * 30 dias * 16h de expediente) = 480h
    expect(result.ocupacaoQuadrasPct).toBe(Math.round((2 / 480) * 100));
  });

  it('resolve o período (query com dias no mês) a partir de `periodo` no formato AAAA-MM', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([{ id: 'q1' }]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
    mockHorarioPadrao();

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

  // =====================================================================
  // SPEC-010/REQ-009 — o denominador passou a ser o horário real
  // =====================================================================

  it('AC-016: dia fechado não entra no denominador', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([{ id: 'q1' }]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
      {
        horaInicio: new Date('1970-01-01T09:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
      },
    ]);
    // Fevereiro de 2026: 28 dias, 4 domingos. Abre 08h–18h (10h) de
    // segunda a sábado e fecha no domingo → 24 dias × 10h = 240h, e não
    // 28 × 16 = 448h como o cálculo antigo diria.
    (prisma.horarioFuncionamento.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: null,
        diaSemana,
        fechado: diaSemana === 0,
        horaInicio:
          diaSemana === 0 ? null : new Date('1970-01-01T08:00:00.000Z'),
        horaFim: diaSemana === 0 ? null : new Date('1970-01-01T18:00:00.000Z'),
      })),
    );

    const result = await service.summary('c1', { periodo: '2026-02' });

    expect(result.ocupacaoQuadrasPct).toBe(Math.round((1 / 240) * 100));
  });

  it('horário próprio da quadra vence o padrão também no KPI', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([{ id: 'q1' }]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
      {
        horaInicio: new Date('1970-01-01T09:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
      },
    ]);
    (prisma.horarioFuncionamento.findMany as jest.Mock).mockResolvedValue([
      ...horarioPadraoDaEmpresa(),
      // A quadra abre só 2h/dia; são 28 dias em fevereiro → 56h.
      ...Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: 'q1',
        diaSemana,
        fechado: false,
        horaInicio: new Date('1970-01-01T08:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
      })),
    ]);

    const result = await service.summary('c1', { periodo: '2026-02' });

    expect(result.ocupacaoQuadrasPct).toBe(Math.round((1 / 56) * 100));
  });

  // AC-017: empresa fechada o período inteiro tem denominador zero — o KPI
  // devolve 0%, não estoura numa divisão.
  it('AC-017: empresa fechada o período inteiro devolve 0%, sem divisão por zero', async () => {
    (prisma.aluno.count as jest.Mock).mockResolvedValue(0);
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.quadra.findMany as jest.Mock).mockResolvedValue([{ id: 'q1' }]);
    (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.horarioFuncionamento.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: null,
        diaSemana,
        fechado: true,
        horaInicio: null,
        horaFim: null,
      })),
    );

    const result = await service.summary('c1', { periodo: '2026-02' });

    expect(result.ocupacaoQuadrasPct).toBe(0);
  });
});

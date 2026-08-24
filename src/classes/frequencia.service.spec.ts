import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FrequenciaService } from './frequencia.service';

// TEST (SPEC-015/TASK-001): o relatório de frequência da turma, com Prisma
// mockado. O que se prova aqui é a aritmética e as regras de composição —
// denominador, cobertura, faltas seguidas, quem aparece e quem não. Escopo
// de empresa (AC-009) também, porque é um WHERE.

function ocorrencia(
  id: string,
  diasAtras: number,
  statusPagamento = 'pendente_pagamento',
) {
  const d = new Date();
  const data = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  data.setUTCDate(data.getUTCDate() - diasAtras);
  return { id, data, statusPagamento };
}

function presenca(alunoId: string, nome: string, status: string) {
  return {
    alunoId,
    status,
    aluno: { status: 'ativo', vinculo: 'aprovado', usuario: { nome } },
  };
}

function buildMocks() {
  const prisma = {
    turma: { findFirst: jest.fn() },
    chamada: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    prisma: prisma as unknown as PrismaService,
    service: new FrequenciaService(prisma as unknown as PrismaService),
  };
}

describe('FrequenciaService (SPEC-015/TASK-001)', () => {
  let prisma: PrismaService;
  let service: FrequenciaService;

  beforeEach(() => {
    const b = buildMocks();
    prisma = b.prisma;
    service = b.service;
  });

  const turma = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    nome: 'Turma 01',
    alunos: [
      {
        alunoId: 'a1',
        aluno: {
          status: 'ativo',
          vinculo: 'aprovado',
          usuario: { nome: 'Ana' },
        },
      },
    ],
    ocupacoes: [],
    ...over,
  });

  // AC-009 — turma de outra empresa é 404, e o escopo é um WHERE, não uma
  // checagem depois de buscar: 403 confirmaria que ela existe.
  it('turma de outra empresa devolve 404', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.daTurma('c1', 't1', 30)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.turma.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: 'c1' }),
      }),
    );
  });

  // AC-003 — a diferença entre "faltou a tudo" e "não há dado" é a coisa
  // mais fácil de errar aqui, e a que mais engana o gestor.
  it('aluno matriculado sem registro no período tem frequenciaPct null, nunca 0', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(turma());

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.alunos).toHaveLength(1);
    expect(r.alunos[0]).toMatchObject({
      alunoId: 'a1',
      frequenciaPct: null,
      base: 0,
    });
  });

  it('frequência é presente ÷ registros do próprio aluno', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({ ocupacoes: [ocorrencia('o1', 3), ocorrencia('o2', 2)] }),
    );
    (prisma.chamada.findMany as jest.Mock).mockResolvedValue([
      { ocupacaoId: 'o1', presencas: [presenca('a1', 'Ana', 'presente')] },
      { ocupacaoId: 'o2', presencas: [presenca('a1', 'Ana', 'ausente')] },
    ]);

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.alunos[0]).toMatchObject({
      frequenciaPct: 50,
      base: 2,
      presente: 1,
      ausente: 1,
    });
  });

  // AC-004 — quem saiu da turma mas tem registro no período continua
  // aparecendo. Some daqui, e o gestor perde o histórico de quem evadiu —
  // que é justamente quem ele quer olhar.
  it('aluno removido da turma com registro continua no relatório, com naTurmaHoje false', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({ ocupacoes: [ocorrencia('o1', 3)] }),
    );
    (prisma.chamada.findMany as jest.Mock).mockResolvedValue([
      {
        ocupacaoId: 'o1',
        presencas: [
          presenca('a1', 'Ana', 'presente'),
          presenca('a9', 'Saiu Depois', 'ausente'),
        ],
      },
    ]);

    const r = await service.daTurma('c1', 't1', 30);

    const saiu = r.alunos.find((a) => a.alunoId === 'a9');
    expect(saiu).toMatchObject({ naTurmaHoje: false, base: 1 });
    expect(r.alunos.find((a) => a.alunoId === 'a1')?.naTurmaHoje).toBe(true);
  });

  // AC-005 — as duas metades, e elas não são simétricas.
  it('cancelada COM chamada conta; cancelada SEM chamada não aparece', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({
        ocupacoes: [
          ocorrencia('o1', 3),
          ocorrencia('o2', 2, 'cancelado'), // cancelada e lançada: conta
          ocorrencia('o3', 1, 'cancelado'), // cancelada e vazia: some
        ],
      }),
    );
    (prisma.chamada.findMany as jest.Mock).mockResolvedValue([
      { ocupacaoId: 'o1', presencas: [presenca('a1', 'Ana', 'presente')] },
      { ocupacaoId: 'o2', presencas: [presenca('a1', 'Ana', 'ausente')] },
    ]);

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.cobertura).toMatchObject({
      aulasQueAconteceram: 2,
      aulasComChamada: 2,
      pct: 100,
    });
    expect(r.alunos[0].base).toBe(2);
  });

  // AC-002 — cobertura é diagnóstico: diz se dá para confiar nos
  // percentuais. Aula sem chamada entra no denominador dela.
  it('cobertura é aulas com chamada ÷ aulas que aconteceram', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({
        ocupacoes: [
          ocorrencia('o1', 3),
          ocorrencia('o2', 2),
          ocorrencia('o3', 1),
        ],
      }),
    );
    (prisma.chamada.findMany as jest.Mock).mockResolvedValue([
      { ocupacaoId: 'o1', presencas: [presenca('a1', 'Ana', 'presente')] },
    ]);

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.cobertura).toMatchObject({
      aulasQueAconteceram: 3,
      aulasComChamada: 1,
      pct: 33.3,
    });
  });

  // AC-006 — pela data da AULA, não pela ordem de gravação: o professor
  // lança a chamada de terça antes da de segunda o tempo todo.
  it('faltas seguidas contam da aula mais recente para trás e param no primeiro presente', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({
        ocupacoes: [
          ocorrencia('o1', 9),
          ocorrencia('o2', 6),
          ocorrencia('o3', 3),
        ],
      }),
    );
    // Devolvidas fora de ordem de propósito.
    (prisma.chamada.findMany as jest.Mock).mockResolvedValue([
      { ocupacaoId: 'o2', presencas: [presenca('a1', 'Ana', 'ausente')] },
      { ocupacaoId: 'o1', presencas: [presenca('a1', 'Ana', 'presente')] },
      { ocupacaoId: 'o3', presencas: [presenca('a1', 'Ana', 'justificado')] },
    ]);

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.alunos[0]).toMatchObject({
      faltasSeguidas: 2,
      faltasSeguidasComposicao: { ausente: 1, justificado: 1 },
    });
  });

  // AC-011 — aparece marcado. Quem decide o que fazer com a marca é a
  // TASK-003 (evasão), não este endpoint.
  it('aluno inativo ou não aprovado aparece, com os sinalizadores', async () => {
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
      turma({
        alunos: [
          {
            alunoId: 'a1',
            aluno: {
              status: 'inativo',
              vinculo: 'pendente',
              usuario: { nome: 'Ana' },
            },
          },
        ],
      }),
    );

    const r = await service.daTurma('c1', 't1', 30);

    expect(r.alunos[0]).toMatchObject({
      alunoAtivo: false,
      vinculo: 'pendente',
    });
  });
});

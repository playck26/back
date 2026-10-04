import { hojeNoFusoDoClube } from '../courts/date-time.util';
import type { CorteDaPresenca } from '../presenca-automatica/corte-da-presenca';
import type { PrismaService } from '../prisma/prisma.service';
import { AvisoDeReferencia, LIMIAR_DE_REFERENCIA } from './aviso-de-referencia';
import { FrequenciaService } from './frequencia.service';

function logger() {
  return { warn: jest.fn() };
}

function ocorrencias(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    data: hojeNoFusoDoClube(),
    statusPagamento: 'pendente_pagamento',
    origemTurmaId: 't1',
    chamadas: [],
    horaInicio: new Date('1970-01-01T10:00:00.000Z'),
    horaFim: new Date('1970-01-01T11:00:00.000Z'),
    origemTurma: { nome: 'Turma 01' },
    reposicoes: [],
    presencas: [],
  }));
}

function servico(n: number, limiar: number) {
  const prisma = {
    turma: {
      findFirst: jest.fn().mockResolvedValue({
        id: 't1',
        nome: 'Turma 01',
        alunos: [],
        ocupacoes: ocorrencias(n),
      }),
    },
    aluno: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'a1',
        status: 'ativo',
        vinculo: 'aprovado',
        usuario: { nome: 'Ana' },
        turmaAlunos: [],
      }),
    },
    ocupacaoQuadra: { findMany: jest.fn().mockResolvedValue(ocorrencias(n)) },
    presenca: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const service = new FrequenciaService(
    prisma as unknown as PrismaService,
    { ler: () => Promise.resolve(null) } as unknown as CorteDaPresenca,
  );
  const log = logger();
  service.aviso = new AvisoDeReferencia(limiar, log);
  return { service, log };
}

describe('SPEC-081 AC-017 — relatório acima do cenário de referência', () => {
  it('o limiar padrão é o cenário de referência do AC-016: 7.800 ocorrências', () => {
    expect(LIMIAR_DE_REFERENCIA).toBe(7_800);
  });

  it('acima do limiar: um aviso, com rota, número e clube — e nada pessoal', () => {
    const log = logger();
    new AvisoDeReferencia(2, log).verificar('evasao', 3, 'c1');

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({
      evento: 'relatorio_acima_da_referencia',
      rota: 'evasao',
      ocorrencias: 3,
      companyId: 'c1',
    });
  });

  it('no limiar ou abaixo: nenhum aviso', () => {
    const log = logger();
    const aviso = new AvisoDeReferencia(2, log);
    aviso.verificar('evasao', 2, 'c1');
    aviso.verificar('evasao', 0, 'c1');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['evasao', (s: FrequenciaService) => s.evasao('c1', 90)],
    ['daTurma', (s: FrequenciaService) => s.daTurma('c1', 't1', 90)],
    ['doAluno', (s: FrequenciaService) => s.doAluno('c1', 'a1', 90)],
  ] as const)(
    '%s: acima do limiar injetado, sai UMA vez por chamada',
    async (rota, chamar) => {
      const { service, log } = servico(3, 2);

      await chamar(service);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ rota, ocorrencias: 3, companyId: 'c1' }),
      );

      await chamar(service);
      expect(log.warn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['evasao', (s: FrequenciaService) => s.evasao('c1', 90)],
    ['daTurma', (s: FrequenciaService) => s.daTurma('c1', 't1', 90)],
    ['doAluno', (s: FrequenciaService) => s.doAluno('c1', 'a1', 90)],
  ] as const)('%s: abaixo do limiar, não sai', async (_rota, chamar) => {
    const { service, log } = servico(2, 2);
    await chamar(service);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

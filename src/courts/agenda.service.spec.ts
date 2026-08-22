import { PrismaService } from '../prisma/prisma.service';
import { AgendaService } from './agenda.service';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { parseTimeOnly } from './date-time.util';

// TEST-012 (SPEC-012): a agenda é leitura agregada. Os testes conferem o
// **custo** tanto quanto o resultado — o achado 002 da validação cruzada
// foi justamente um N+1 escondido atrás de "reusar a resolução de horário".

const COMPANY = 'c1';

function horarioPadrao(fechadoNoDomingo = false) {
  return Array.from({ length: 7 }, (_, diaSemana) => ({
    quadraId: null,
    diaSemana,
    fechado: fechadoNoDomingo && diaSemana === 0,
    horaInicio:
      fechadoNoDomingo && diaSemana === 0 ? null : parseTimeOnly('08:00'),
    horaFim:
      fechadoNoDomingo && diaSemana === 0 ? null : parseTimeOnly('18:00'),
  }));
}

function build(opts: {
  grupos?: unknown[];
  quadras?: { id: string }[];
  linhas?: unknown[];
  ocupacoes?: unknown[];
}) {
  const prisma = {
    ocupacaoQuadra: {
      groupBy: jest.fn().mockResolvedValue(opts.grupos ?? []),
      findMany: jest.fn().mockResolvedValue(opts.ocupacoes ?? []),
    },
    quadra: {
      findMany: jest.fn().mockResolvedValue(opts.quadras ?? [{ id: 'q1' }]),
    },
    horarioFuncionamento: {
      findMany: jest.fn().mockResolvedValue(opts.linhas ?? horarioPadrao()),
    },
  };
  const horarios = new HorarioFuncionamentoService(
    prisma as unknown as PrismaService,
  );
  return {
    prisma,
    service: new AgendaService(prisma as unknown as PrismaService, horarios),
  };
}

describe('AgendaService (SPEC-012)', () => {
  describe('resumoDoMes', () => {
    it('AC-001: agrega por dia, separando pendentes do total', async () => {
      const { service } = build({
        grupos: [
          {
            data: new Date('2026-08-03T00:00:00.000Z'),
            statusPagamento: 'pendente_pagamento',
            _count: { _all: 2 },
          },
          {
            data: new Date('2026-08-03T00:00:00.000Z'),
            statusPagamento: 'pago',
            _count: { _all: 1 },
          },
        ],
      });

      const dias = await service.resumoDoMes(COMPANY, '2026-08');

      expect(dias).toHaveLength(31);
      const dia3 = dias.find((d) => d.data === '2026-08-03');
      expect(dia3).toMatchObject({ total: 3, pendentes: 2 });
      // Dia sem ocupação aparece zerado, não some da lista — o calendário
      // precisa desenhar o mês inteiro.
      expect(dias.find((d) => d.data === '2026-08-04')).toMatchObject({
        total: 0,
        pendentes: 0,
      });
    });

    // AC-002 e AC-010: o custo não pode crescer com o mês nem com o número
    // de quadras. Três consultas, sempre.
    it('AC-002/AC-010: usa 3 consultas, independentemente de dias e quadras', async () => {
      const { service, prisma } = build({
        quadras: Array.from({ length: 8 }, (_, i) => ({ id: `q${i}` })),
      });

      await service.resumoDoMes(COMPANY, '2026-08');

      expect(prisma.ocupacaoQuadra.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.quadra.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.horarioFuncionamento.findMany).toHaveBeenCalledTimes(1);
    });

    it('AC-002: a agregação exclui cancelada e quadra inativa', async () => {
      const { service, prisma } = build({});

      await service.resumoDoMes(COMPANY, '2026-08');

      const [args] = prisma.ocupacaoQuadra.groupBy.mock.calls[0] as [
        {
          by: string[];
          where: {
            companyId: string;
            statusPagamento: { not: string };
            quadra: { status: string };
          };
        },
      ];
      expect(args.by).toEqual(['data', 'statusPagamento']);
      expect(args.where.companyId).toBe(COMPANY);
      expect(args.where.statusPagamento.not).toBe('cancelado');
      expect(args.where.quadra.status).toBe('ativa');
    });

    it('AC-008: domingo com todas as quadras fechadas vem marcado como fechado', async () => {
      const { service } = build({ linhas: horarioPadrao(true) });

      const dias = await service.resumoDoMes(COMPANY, '2026-08');

      // 2026-08-02 é domingo.
      expect(dias.find((d) => d.data === '2026-08-02')?.fechado).toBe(true);
      expect(dias.find((d) => d.data === '2026-08-03')?.fechado).toBe(false);
    });

    it('quadra com horário próprio aberto impede marcar o dia como fechado', async () => {
      const { service } = build({
        quadras: [{ id: 'q1' }, { id: 'q2' }],
        linhas: [
          ...horarioPadrao(true),
          // q2 abre no domingo, contrariando o padrão.
          {
            quadraId: 'q2',
            diaSemana: 0,
            fechado: false,
            horaInicio: parseTimeOnly('09:00'),
            horaFim: parseTimeOnly('12:00'),
          },
        ],
      });

      const dias = await service.resumoDoMes(COMPANY, '2026-08');

      expect(dias.find((d) => d.data === '2026-08-02')?.fechado).toBe(false);
    });
  });

  describe('detalheDoDia', () => {
    const base = {
      id: 'o1',
      quadra: { nome: 'Quadra 1' },
      horaInicio: parseTimeOnly('09:00'),
      horaFim: parseTimeOnly('10:00'),
      statusPagamento: 'pendente_pagamento',
    };

    it('AC-003: devolve quadra, horário, origem, responsável e status', async () => {
      const { service } = build({
        ocupacoes: [
          {
            ...base,
            origemTipo: 'AVULSO',
            aluno: { usuario: { nome: 'Israel' } },
            origemTurma: null,
          },
        ],
      });

      const itens = await service.detalheDoDia(COMPANY, '2026-08-24');

      expect(itens[0]).toEqual({
        id: 'o1',
        quadraNome: 'Quadra 1',
        horaInicio: '09:00',
        horaFim: '10:00',
        origemTipo: 'AVULSO',
        responsavel: 'Israel',
        statusPagamento: 'pendente_pagamento',
      });
    });

    // AC-004: ocupação de turma não tem `aluno_id` — quem responde por ela
    // é a turma. Mesma razão do AC-019 de SPEC-010.
    it('AC-004: ocupação de turma é identificada pela turma', async () => {
      const { service } = build({
        ocupacoes: [
          {
            ...base,
            origemTipo: 'TURMA',
            aluno: null,
            origemTurma: { nome: 'Turma das 9h' },
          },
        ],
      });

      const itens = await service.detalheDoDia(COMPANY, '2026-08-24');

      expect(itens[0].responsavel).toBe('Turma das 9h');
    });

    it('AC-009: a consulta é sempre escopada pela empresa do token', async () => {
      const { service, prisma } = build({});

      await service.detalheDoDia(COMPANY, '2026-08-24');

      const [args] = prisma.ocupacaoQuadra.findMany.mock.calls[0] as [
        { where: { companyId: string } },
      ];
      expect(args.where.companyId).toBe(COMPANY);
    });
  });
});

import { PrismaService } from '../prisma/prisma.service';
import { parseTimeOnly } from './date-time.util';
import {
  HorarioFuncionamentoService,
  type HorarioEfetivo,
} from './horario-funcionamento.service';

// TEST-010 (SPEC-010): a resolução do horário efetivo é a única fonte de
// verdade sobre "estar aberto" — availability e criação de ocupação usam
// esta mesma função (REQ-008/AC-015).

const COMPANY = 'c1';
const QUADRA = 'q1';

interface TxHorarios {
  horarioFuncionamento: { deleteMany: jest.Mock; createMany: jest.Mock };
}

function build(linhas: unknown[], ocupacoes: unknown[] = []) {
  const tx: TxHorarios = {
    horarioFuncionamento: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  };
  const prisma = {
    horarioFuncionamento: {
      findMany: jest.fn().mockResolvedValue(linhas),
      deleteMany: jest.fn(),
    },
    ocupacaoQuadra: { findMany: jest.fn().mockResolvedValue(ocupacoes) },
    quadra: { findFirst: jest.fn().mockResolvedValue({ id: QUADRA }) },
    $transaction: jest.fn((cb: (t: TxHorarios) => unknown) => cb(tx)),
    tx,
  };
  return {
    prisma,
    service: new HorarioFuncionamentoService(
      prisma as unknown as PrismaService,
    ),
  };
}

const linhaEmpresa = (over: Record<string, unknown> = {}) => ({
  quadraId: null,
  fechado: false,
  horaInicio: parseTimeOnly('06:00'),
  horaFim: parseTimeOnly('22:00'),
  ...over,
});

const linhaQuadra = (over: Record<string, unknown> = {}) => ({
  quadraId: QUADRA,
  fechado: false,
  horaInicio: parseTimeOnly('08:00'),
  horaFim: parseTimeOnly('18:00'),
  ...over,
});

describe('HorarioFuncionamentoService (SPEC-010)', () => {
  describe('resolver — herança', () => {
    it('AC-005: quadra sem horário próprio herda o padrão da empresa', async () => {
      const { service } = build([linhaEmpresa()]);

      const r = await service.resolver(COMPANY, QUADRA, 1);

      expect(r).toEqual({
        estado: 'aberto',
        horaInicio: parseTimeOnly('06:00'),
        horaFim: parseTimeOnly('22:00'),
      });
    });

    it('AC-006: horário próprio da quadra vence o padrão', async () => {
      const { service } = build([linhaEmpresa(), linhaQuadra()]);

      const r = await service.resolver(COMPANY, QUADRA, 1);

      expect(r).toEqual({
        estado: 'aberto',
        horaInicio: parseTimeOnly('08:00'),
        horaFim: parseTimeOnly('18:00'),
      });
    });

    // NFR-001: uma consulta, não duas. Numa rota chamada a cada troca de
    // dia na tela do aluno, "duas consultas" vira o dobro do custo.
    it('resolve com uma consulta só, buscando as duas linhas de uma vez', async () => {
      const { service, prisma } = build([linhaEmpresa(), linhaQuadra()]);

      await service.resolver(COMPANY, QUADRA, 1);

      expect(prisma.horarioFuncionamento.findMany).toHaveBeenCalledTimes(1);
    });

    it('quadra fechada naquele dia devolve estado fechado, mesmo com a empresa aberta', async () => {
      const { service } = build([
        linhaEmpresa(),
        linhaQuadra({ fechado: true, horaInicio: null, horaFim: null }),
      ]);

      expect(await service.resolver(COMPANY, QUADRA, 0)).toEqual({
        estado: 'fechado',
      });
    });

    // Rede de segurança: empresa sem nenhuma linha mantém o comportamento
    // anterior à spec, em vez de sumir da agenda dos próprios alunos.
    it('sem configuração alguma, cai no 6h–22h de antes da SPEC-010', async () => {
      const { service } = build([]);

      expect(await service.resolver(COMPANY, QUADRA, 3)).toEqual({
        estado: 'aberto',
        horaInicio: parseTimeOnly('06:00'),
        horaFim: parseTimeOnly('22:00'),
      });
    });

    it('resolverParaData usa o dia da semana em UTC (0 = domingo)', async () => {
      const { service, prisma } = build([linhaEmpresa()]);

      // 2026-08-23 é um domingo.
      await service.resolverParaData(
        COMPANY,
        QUADRA,
        new Date('2026-08-23T00:00:00.000Z'),
      );

      const [args] = prisma.horarioFuncionamento.findMany.mock.calls[0] as [
        { where: { diaSemana: number } },
      ];
      expect(args.where.diaSemana).toBe(0);
    });
  });

  describe('gerarSlots', () => {
    it('gera slots de 1h que terminam exatamente no fechamento', () => {
      const { service } = build([]);
      const horario: HorarioEfetivo = {
        estado: 'aberto',
        horaInicio: parseTimeOnly('08:00'),
        horaFim: parseTimeOnly('11:00'),
      };

      const slots = service.gerarSlots(horario);

      expect(slots).toHaveLength(3);
      expect(slots[0].inicio).toEqual(parseTimeOnly('08:00'));
      expect(slots[2].fim).toEqual(parseTimeOnly('11:00'));
    });

    it('AC-008: dia fechado não tem slot — e isso não é erro', () => {
      const { service } = build([]);

      expect(service.gerarSlots({ estado: 'fechado' })).toEqual([]);
    });
  });

  describe('dentroDoExpediente (REQ-010)', () => {
    const aberto: HorarioEfetivo = {
      estado: 'aberto',
      horaInicio: parseTimeOnly('06:00'),
      horaFim: parseTimeOnly('10:00'),
    };

    it('AC-021: aceita intervalo que encosta nas duas bordas', () => {
      const { service } = build([]);

      expect(
        service.dentroDoExpediente(
          aberto,
          parseTimeOnly('06:00'),
          parseTimeOnly('10:00'),
        ),
      ).toBe(true);
    });

    // AC-022 — o caso que separa as duas semânticas do domínio: conflito é
    // semiaberto (10:00-11:00 não colide com 09:00-10:00), mas expediente
    // é fechado nas duas pontas, então 10:00-11:00 está FORA de um
    // expediente que termina às 10:00.
    it('AC-022: recusa 10:00–11:00 num expediente que fecha às 10:00', () => {
      const { service } = build([]);

      expect(
        service.dentroDoExpediente(
          aberto,
          parseTimeOnly('10:00'),
          parseTimeOnly('11:00'),
        ),
      ).toBe(false);
    });

    it('recusa intervalo que começa antes da abertura', () => {
      const { service } = build([]);

      expect(
        service.dentroDoExpediente(
          aberto,
          parseTimeOnly('05:00'),
          parseTimeOnly('06:00'),
        ),
      ).toBe(false);
    });

    it('dia fechado recusa qualquer intervalo', () => {
      const { service } = build([]);

      expect(
        service.dentroDoExpediente(
          { estado: 'fechado' },
          parseTimeOnly('09:00'),
          parseTimeOnly('10:00'),
        ),
      ).toBe(false);
    });
  });

  // =====================================================================
  // SPEC-010/REQ-001, REQ-002, REQ-006 — configuração e relatório
  // =====================================================================

  const semanaAberta = (horaInicio = '08:00', horaFim = '18:00') =>
    Array.from({ length: 7 }, (_, diaSemana) => ({
      diaSemana,
      fechado: false,
      horaInicio,
      horaFim,
    }));

  describe('definir', () => {
    it('AC-002: fechamento antes da abertura devolve 422 com o dia no texto', async () => {
      const { service } = build([]);
      const dias = semanaAberta();
      dias[3] = {
        diaSemana: 3,
        fechado: false,
        horaInicio: '20:00',
        horaFim: '08:00',
      };

      await expect(
        service.definirPadraoDaEmpresa(COMPANY, { dias }),
      ).rejects.toThrow(/Dia 3/);
    });

    it('recusa dia aberto sem horas', async () => {
      const { service } = build([]);
      const dias = semanaAberta();
      dias[1] = { diaSemana: 1, fechado: false } as never;

      await expect(
        service.definirPadraoDaEmpresa(COMPANY, { dias }),
      ).rejects.toThrow(/Dia 1/);
    });

    // Substituir a semana inteira numa transação: estado parcial
    // significaria agenda inconsistente entre dois dias da mesma semana.
    it('substitui a semana inteira dentro de uma transação', async () => {
      const { service, prisma } = build([]);

      await service.definirPadraoDaEmpresa(COMPANY, { dias: semanaAberta() });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tx.horarioFuncionamento.deleteMany).toHaveBeenCalledWith({
        where: { companyId: COMPANY, quadraId: null },
      });
      const [args] = prisma.tx.horarioFuncionamento.createMany.mock
        .calls[0] as [{ data: unknown[] }];
      expect(args.data).toHaveLength(7);
    });

    it('AC-004: remover o horário próprio apaga só as linhas da quadra', async () => {
      const { service, prisma } = build([]);

      await service.removerDaQuadra(COMPANY, QUADRA);

      expect(prisma.horarioFuncionamento.deleteMany).toHaveBeenCalledWith({
        where: { companyId: COMPANY, quadraId: QUADRA },
      });
    });
  });

  describe('relatório de impacto (REQ-006)', () => {
    const ocupacaoFora = {
      quadraId: QUADRA,
      origemTipo: 'AVULSO',
      data: new Date('2026-09-06T00:00:00.000Z'), // domingo
      horaInicio: parseTimeOnly('09:00'),
      horaFim: parseTimeOnly('10:00'),
      quadra: { nome: 'Quadra 1' },
      aluno: { usuario: { nome: 'Israel' } },
      origemTurma: null,
    };

    it('AC-011/AC-012: lista o que ficou fora e não cancela nada', async () => {
      // Domingo fechado no novo horário.
      const novoHorario = Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: null,
        diaSemana,
        fechado: diaSemana === 0,
        horaInicio: diaSemana === 0 ? null : parseTimeOnly('08:00'),
        horaFim: diaSemana === 0 ? null : parseTimeOnly('18:00'),
      }));
      const { service, prisma } = build(novoHorario, [ocupacaoFora]);

      const r = await service.definirPadraoDaEmpresa(COMPANY, {
        dias: semanaAberta(),
      });

      expect(r.afetadasCount).toBe(1);
      expect(r.amostra[0]).toMatchObject({
        origemTipo: 'AVULSO',
        quadraNome: 'Quadra 1',
        responsavel: 'Israel',
      });
      // Nada de update/delete em ocupações: a decisão é do gerente.
      expect(prisma.ocupacaoQuadra).not.toHaveProperty('updateMany');
    });

    it('AC-019: ocupação de turma é identificada pela turma, não pelo aluno', async () => {
      const novoHorario = Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: null,
        diaSemana,
        fechado: true,
        horaInicio: null,
        horaFim: null,
      }));
      const { service } = build(novoHorario, [
        {
          ...ocupacaoFora,
          origemTipo: 'TURMA',
          aluno: null,
          origemTurma: { nome: 'Turma das 9h' },
        },
      ]);

      const r = await service.definirPadraoDaEmpresa(COMPANY, {
        dias: semanaAberta(),
      });

      expect(r.amostra[0].responsavel).toBe('Turma das 9h');
    });

    // AC-011: teto de 20. Lista sem limite cresce com a agenda e transforma
    // uma resposta de configuração num dump.
    it('AC-011: amostra tem teto de 20, mas a contagem é total', async () => {
      const novoHorario = Array.from({ length: 7 }, (_, diaSemana) => ({
        quadraId: null,
        diaSemana,
        fechado: true,
        horaInicio: null,
        horaFim: null,
      }));
      const muitas = Array.from({ length: 57 }, () => ({ ...ocupacaoFora }));
      const { service } = build(novoHorario, muitas);

      const r = await service.definirPadraoDaEmpresa(COMPANY, {
        dias: semanaAberta(),
      });

      expect(r.afetadasCount).toBe(57);
      expect(r.amostra).toHaveLength(20);
    });
  });
});

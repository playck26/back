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
  matriculas?: { turmaId: string; alunoId: string }[];
  faltas?: { ocupacaoId: string; alunoId: string }[];
  reposicoes?: unknown[];
  ocorrenciaDeTurma?: { id: string } | null;
}) {
  const prisma = {
    // SPEC-060/D4 — o resumo do mês deixou de ser `groupBy` e passou a ser um
    // `$queryRaw` com `FILTER`: "AVULSO sem professor" não é chave de grupo.
    $queryRaw: jest.fn().mockResolvedValue(opts.grupos ?? []),
    ocupacaoQuadra: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue(opts.ocupacoes ?? []),
      findFirst: jest.fn().mockResolvedValue(opts.ocorrenciaDeTurma ?? null),
    },
    // SPEC-057/TASK-005/D17 — os três conjuntos da ocupação da aula.
    turmaAluno: {
      findMany: jest.fn().mockResolvedValue(opts.matriculas ?? []),
    },
    faltaAvisada: {
      findMany: jest.fn().mockResolvedValue(opts.faltas ?? []),
    },
    reposicaoDeAula: {
      findMany: jest.fn().mockResolvedValue(opts.reposicoes ?? []),
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
            total: 3n,
            pendentes: 2n,
            turmas: 1n,
            particulares: 1n,
            quadras: 1n,
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

      // SPEC-060: a agregação virou `$queryRaw`, e continua sendo UMA.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.quadra.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.horarioFuncionamento.findMany).toHaveBeenCalledTimes(1);
    });

    /**
     * SPEC-060 — o recorte continua o mesmo depois de virar SQL cru, e isto é
     * prova de TEXTO porque o `$queryRaw` guarda o template. Frágil de
     * propósito: se alguém reescrever a consulta e deixar cair o filtro de
     * cancelada ou de quadra inativa, o teste cai junto.
     */
    it('AC-002: a agregação exclui cancelada e quadra inativa', async () => {
      const { service, prisma } = build({});

      await service.resumoDoMes(COMPANY, '2026-08');

      const [partes] = prisma.$queryRaw.mock.calls[0] as [string[]];
      const sql = partes.join(' ? ');
      expect(sql).toContain("o.status_pagamento <> 'cancelado'");
      expect(sql).toContain("q.status = 'ativa'");
      // As três contagens saem do MESMO conjunto de linhas (INV-060a).
      expect(sql).toContain("FILTER (WHERE o.origem_tipo = 'TURMA')");
      expect(sql).toContain('o.professor_id IS NOT NULL');
      expect(sql).toContain('o.professor_id IS NULL');
    });

    it('AC-003: as três contagens somam o total, e o dia vazio vem zerado', async () => {
      const { service } = build({
        grupos: [
          {
            data: new Date('2026-08-03T00:00:00.000Z'),
            total: 7n,
            pendentes: 2n,
            turmas: 4n,
            particulares: 2n,
            quadras: 1n,
          },
        ],
      });

      const dias = await service.resumoDoMes(COMPANY, '2026-08');

      const dia3 = dias.find((d) => d.data === '2026-08-03');
      expect(dia3).toMatchObject({
        total: 7,
        turmas: 4,
        particulares: 2,
        quadras: 1,
      });
      expect(dia3!.turmas + dia3!.particulares + dia3!.quadras).toBe(dia3!.total);
      expect(dias.find((d) => d.data === '2026-08-04')).toMatchObject({
        total: 0,
        turmas: 0,
        particulares: 0,
        quadras: 0,
      });
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
      quadra: { nome: 'Quadra 1', cor: '#31658C', codigoAgenda: 7 },
      professorId: null,
      horaInicio: parseTimeOnly('09:00'),
      horaFim: parseTimeOnly('10:00'),
      statusPagamento: 'pendente_pagamento',
      // SPEC-011: valor congelado na criação.
      valor: 160,
      // SPEC-054/D12 — o include traz os itens.
      adicionais: [],
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
        valor: 160,
        // SPEC-032/AC-009 — nulo e o estado normal de linha anterior a spec
        // (LIM-032a): a tela mostra "sem historico", nao "criada por —".
        criadaPor: null,
        canceladaPor: null,
        adicionais: [],
        // SPEC-057/TASK-005/D19 — a quadra se identifica por nome + código,
        // e a cor é auxiliar.
        quadraCor: '#31658C',
        quadraCodigoAgenda: '7',
        tipoVisual: 'AVULSO',
        // SPEC-057/TASK-005/D17 — ocupação da aula só existe em TURMA.
        capacidade: null,
        matriculados: null,
        faltasAvisadas: null,
        reposicoesMarcadas: null,
        reposicoesNaOcupacao: null,
        ocupados: null,
        vagasNaOcorrencia: null,
      });
    });

    // SPEC-032/AC-009 — as duas pontas, e a segunda tem regra propria.
    it('resolve criadaPor e canceladaPor a partir dos eventos', async () => {
      const { service } = build({
        ocupacoes: [
          {
            ...base,
            origemTipo: 'AVULSO',
            aluno: { usuario: { nome: 'Israel' } },
            origemTurma: null,
            statusPagamento: 'cancelado',
            // Em ordem cronologica, como a consulta pede. DOIS
            // cancelamentos: o caso que a SPEC-035 (reativacao) torna real.
            eventos: [
              { tipo: 'criada', acao: { autor: { nome: 'Maria' } } },
              { tipo: 'cancelada', acao: { autor: { nome: 'Gabriel' } } },
              { tipo: 'reativada', acao: { autor: { nome: 'Maria' } } },
              { tipo: 'cancelada', acao: { autor: { nome: 'Leandro' } } },
            ],
          },
        ],
      });

      const itens = await service.detalheDoDia(COMPANY, '2026-08-24');

      expect(itens[0].criadaPor).toBe('Maria');
      // O ULTIMO cancelamento, nao o primeiro. Quem pergunta "quem cancelou
      // isto?" quer o estado atual — trocar `at(-1)` por `at(0)` devolveria
      // 'Gabriel', que cancelou uma vida passada desta reserva.
      expect(itens[0].canceladaPor).toBe('Leandro');
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

  describe('SPEC-057/TASK-005 — a aula de turma na agenda do gestor', () => {
    let seq = 0;
    function item(
      over: Record<string, unknown> & { dia?: string } = {},
    ): Record<string, unknown> {
      seq += 1;
      const { dia, ...resto } = over;
      return {
        id: `oc${seq}`,
        quadraId: 'q1',
        quadra: { nome: 'Quadra 1', cor: '#00763A', codigoAgenda: 3 },
        data: new Date(`${dia ?? '2026-09-20'}T00:00:00.000Z`),
        horaInicio: parseTimeOnly('09:00'),
        horaFim: parseTimeOnly('10:00'),
        origemTipo: 'TURMA',
        origemTurmaId: 't1',
        origemTurma: { nome: 'Turma das 9h', capacidade: 3 },
        professorId: null,
        aluno: null,
        statusPagamento: 'pendente_pagamento',
        valor: null,
        eventos: [],
        adicionais: [],
        ...resto,
      };
    }

    it('D17: TURMA traz as sete contagens pelos conjuntos M/F/V', async () => {
      const { service } = build({
        ocupacoes: [item({ id: 'oc-a' })],
        // M = {a, b}; F = {b, x} (x saiu da turma e a falta ficou); V = {b, c}.
        matriculas: [
          { turmaId: 't1', alunoId: 'a' },
          { turmaId: 't1', alunoId: 'b' },
        ],
        faltas: [
          { ocupacaoId: 'oc-a', alunoId: 'b' },
          { ocupacaoId: 'oc-a', alunoId: 'x' },
        ],
        reposicoes: [
          { ocupacaoId: 'oc-a', alunoId: 'b' },
          { ocupacaoId: 'oc-a', alunoId: 'c' },
        ],
      });

      const [aula] = await service.detalheDoDia(COMPANY, '2026-09-20');

      expect(aula).toMatchObject({
        tipoVisual: 'TURMA',
        capacidade: 3,
        matriculados: 2,
        faltasAvisadas: 1,
        reposicoesMarcadas: 2,
        reposicoesNaOcupacao: 2,
        ocupados: 3,
        vagasNaOcorrencia: 0,
      });
    });

    it('D19: tipoVisual — PARTICULAR é AVULSO com professor; sem professor é AVULSO', async () => {
      const { service } = build({
        ocupacoes: [
          item({
            id: 'com-prof',
            origemTipo: 'AVULSO',
            origemTurmaId: null,
            origemTurma: null,
            professorId: 'p1',
            aluno: { usuario: { nome: 'Ana' } },
          }),
          item({
            id: 'sem-prof',
            origemTipo: 'AVULSO',
            origemTurmaId: null,
            origemTurma: null,
            aluno: { usuario: { nome: 'Bia' } },
          }),
        ],
      });

      const itens = await service.detalheDoDia(COMPANY, '2026-09-20');

      expect(itens.map((i) => [i.id, i.tipoVisual])).toEqual([
        ['com-prof', 'PARTICULAR'],
        ['sem-prof', 'AVULSO'],
      ]);
    });

    it('sem TURMA na janela, os conjuntos NÃO são consultados', async () => {
      const { service, prisma } = build({
        ocupacoes: [
          item({
            origemTipo: 'AVULSO',
            origemTurmaId: null,
            origemTurma: null,
            aluno: { usuario: { nome: 'Ana' } },
          }),
        ],
      });

      await service.detalheDoDia(COMPANY, '2026-09-20');

      expect(prisma.turmaAluno.findMany).not.toHaveBeenCalled();
      expect(prisma.faltaAvisada.findMany).not.toHaveBeenCalled();
      expect(prisma.reposicaoDeAula.findMany).not.toHaveBeenCalled();
    });

    it.each([20, 200])(
      'NFR-001: semana com %i aulas de turma custa exatamente três consultas a mais',
      async (n) => {
        const dias = ['2026-09-20', '2026-09-21', '2026-09-22'];
        const { service, prisma } = build({
          ocupacoes: Array.from({ length: n }, (_, i) =>
            item({ dia: dias[i % 3], origemTurmaId: `t${i % 7}` }),
          ),
        });

        await service.semanaDe(COMPANY, '2026-09-20');

        expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.turmaAluno.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.faltaAvisada.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.reposicaoDeAula.findMany).toHaveBeenCalledTimes(1);
      },
    );

    it.each([20, 200])(
      'NFR-001: dia com %i aulas de turma custa exatamente três consultas a mais',
      async (n) => {
        const { service, prisma } = build({
          ocupacoes: Array.from({ length: n }, (_, i) =>
            item({ origemTurmaId: `t${i % 7}` }),
          ),
        });

        await service.detalheDoDia(COMPANY, '2026-09-20');

        expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.turmaAluno.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.faltaAvisada.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.reposicaoDeAula.findMany).toHaveBeenCalledTimes(1);
      },
    );

    it('NFR-001: o mês continua sem nenhuma consulta de participante', async () => {
      const { service, prisma } = build({});

      await service.resumoDoMes(COMPANY, '2026-09');

      expect(prisma.turmaAluno.findMany).not.toHaveBeenCalled();
      expect(prisma.faltaAvisada.findMany).not.toHaveBeenCalled();
      expect(prisma.reposicaoDeAula.findMany).not.toHaveBeenCalled();
    });

    it('SPEC-034/AC-001 continua: o item da semana é igual, campo a campo, ao do dia', async () => {
      const dados = () => ({
        ocupacoes: [item({ id: 'mesma' })],
        matriculas: [{ turmaId: 't1', alunoId: 'a' }],
        reposicoes: [{ ocupacaoId: 'mesma', alunoId: 'z' }],
      });

      const doDia = await build(dados()).service.detalheDoDia(
        COMPANY,
        '2026-09-20',
      );
      const daSemana = await build(dados()).service.semanaDe(
        COMPANY,
        '2026-09-20',
      );

      expect(daSemana[0].itens[0]).toEqual(doDia[0]);
    });

    it('D17: nomes de visitantes NÃO vêm no item', async () => {
      const { service } = build({ ocupacoes: [item()] });

      const [aula] = await service.detalheDoDia(COMPANY, '2026-09-20');

      expect(Object.keys(aula)).not.toContain('visitantes');
    });

    describe('visitantesDaOcorrencia', () => {
      it('lista nome e nível, identificados como reposição, em ordem alfabética', async () => {
        const { service } = build({
          ocorrenciaDeTurma: { id: 'oc-x' },
          reposicoes: [
            {
              alunoId: 'a2',
              aluno: { nivelId: null, nivel: null, usuario: { nome: 'Zeca' } },
            },
            {
              alunoId: 'a1',
              aluno: {
                nivelId: 'n1',
                nivel: { nome: 'Intermediário' },
                usuario: { nome: 'Ana' },
              },
            },
          ],
        });

        const r = await service.visitantesDaOcorrencia(COMPANY, 'oc-x');

        expect(r).toEqual([
          {
            alunoId: 'a1',
            nome: 'Ana',
            nivelId: 'n1',
            nivelNome: 'Intermediário',
            tipo: 'reposicao',
          },
          {
            alunoId: 'a2',
            nome: 'Zeca',
            nivelId: null,
            nivelNome: null,
            tipo: 'reposicao',
          },
        ]);
      });

      it('escopo: a ocorrência de TURMA e as visitas são procuradas pela empresa do token', async () => {
        const { service, prisma } = build({
          ocorrenciaDeTurma: { id: 'oc-x' },
        });

        await service.visitantesDaOcorrencia(COMPANY, 'oc-x');

        const [oc] = prisma.ocupacaoQuadra.findFirst.mock.calls[0] as [
          { where: Record<string, unknown> },
        ];
        expect(oc.where).toEqual({
          id: 'oc-x',
          companyId: COMPANY,
          origemTipo: 'TURMA',
        });
        const [rep] = prisma.reposicaoDeAula.findMany.mock.calls[0] as [
          { where: Record<string, unknown> },
        ];
        expect(rep.where).toEqual({ companyId: COMPANY, ocupacaoId: 'oc-x' });
      });

      it('ocorrência de outra empresa, inexistente ou AVULSO → 404, sem ler visitas', async () => {
        const { service, prisma } = build({ ocorrenciaDeTurma: null });

        await expect(
          service.visitantesDaOcorrencia(COMPANY, 'oc-x'),
        ).rejects.toMatchObject({ status: 404 });
        expect(prisma.reposicaoDeAula.findMany).not.toHaveBeenCalled();
      });

      it('não expõe contato: as chaves são exatamente as cinco do contrato', async () => {
        const { service } = build({
          ocorrenciaDeTurma: { id: 'oc-x' },
          reposicoes: [
            {
              alunoId: 'a1',
              aluno: {
                nivelId: null,
                nivel: null,
                usuario: { nome: 'Ana', email: 'ana@x.com' },
              },
            },
          ],
        });

        const [v] = await service.visitantesDaOcorrencia(COMPANY, 'oc-x');

        expect(Object.keys(v).sort()).toEqual(
          ['alunoId', 'nivelId', 'nivelNome', 'nome', 'tipo'].sort(),
        );
      });
    });
  });
});

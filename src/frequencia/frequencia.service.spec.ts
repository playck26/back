import { NotFoundException } from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { FrequenciaService } from './frequencia.service';

// TEST (SPEC-015): os três relatórios, com Prisma mockado. O que se prova
// aqui é a aritmética e a composição — denominador, cobertura em três
// números, piso de confiança, régua de risco e ordenação. Escopo de
// empresa também, porque é um WHERE.

/**
 * DEF-020 — mesma convenção do serviço (`hojeNoFusoDoClube`). Em UTC, das
 * 21h à meia-noite o helper e o serviço discordavam do dia, e o resultado
 * dependia da hora em que a suíte rodasse.
 */
function diaAtras(dias: number): Date {
  const data = hojeNoFusoDoClube();
  data.setUTCDate(data.getUTCDate() - dias);
  return data;
}

/**
 * A ocorrência como o Prisma devolve: `chamadas` é LISTA (a FK é composta),
 * e `_count.presencas` é o que separa "lançada" de "só tem cabeçalho".
 */
function ocorrencia(
  id: string,
  dias: number,
  opts: {
    turmaId?: string;
    cancelada?: boolean;
    completude?: 'completa' | 'desconhecida' | null;
    presencas?: number;
    turmaNome?: string;
  } = {},
) {
  const completude =
    opts.completude === undefined ? 'completa' : opts.completude;
  const presencas = opts.presencas ?? (completude ? 1 : 0);
  return {
    id,
    data: diaAtras(dias),
    statusPagamento: opts.cancelada ? 'cancelado' : 'pendente_pagamento',
    origemTurmaId: opts.turmaId ?? 't1',
    chamadas: completude ? [{ completude }] : [],
    _count: { presencas },
    origemTurma: { nome: opts.turmaNome ?? 'Turma 01' },
  };
}

function presenca(alunoId: string, nome: string, status: string, over = {}) {
  return {
    alunoId,
    status,
    aluno: {
      status: 'ativo',
      vinculo: 'aprovado',
      usuario: { nome },
      ...over,
    },
  };
}

function buildMocks() {
  const prisma = {
    turma: { findFirst: jest.fn() },
    aluno: { findFirst: jest.fn() },
    presenca: { findMany: jest.fn().mockResolvedValue([]) },
    ocupacaoQuadra: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    prisma: prisma as unknown as PrismaService,
    service: new FrequenciaService(prisma as unknown as PrismaService),
  };
}

describe('FrequenciaService (SPEC-015)', () => {
  let prisma: PrismaService;
  let service: FrequenciaService;

  beforeEach(() => {
    const b = buildMocks();
    prisma = b.prisma;
    service = b.service;
  });

  const aluno = (id: string, nome: string, over = {}) => ({
    alunoId: id,
    aluno: {
      status: 'ativo',
      vinculo: 'aprovado',
      usuario: { nome },
      ...over,
    },
  });

  const turma = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    nome: 'Turma 01',
    alunos: [aluno('a1', 'Ana')],
    ocupacoes: [],
    ...over,
  });

  // ================================================================
  describe('daTurma (TASK-001)', () => {
    it('turma de outra empresa devolve 404, e o escopo é WHERE', async () => {
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
    it('aluno matriculado sem registro: frequenciaPct null, nunca 0', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(turma());

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.alunos).toHaveLength(1);
      expect(r.alunos[0]).toMatchObject({ frequenciaPct: null, base: 0 });
    });

    it('frequência é presente ÷ registros do próprio aluno', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({ ocupacoes: [ocorrencia('o1', 3), ocorrencia('o2', 2)] }),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
      ]);

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.alunos[0]).toMatchObject({
        frequenciaPct: 50,
        base: 2,
        presente: 1,
        ausente: 1,
      });
    });

    // AC-004 — some daqui, e o gestor perde o histórico de quem evadiu,
    // que é justamente quem ele quer olhar.
    it('aluno removido da turma com registro continua, com naTurmaHoje false', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({ ocupacoes: [ocorrencia('o1', 3)] }),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a9', 'Saiu Depois', 'ausente'), ocupacaoId: 'o1' },
      ]);

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.alunos.find((a) => a.alunoId === 'a9')).toMatchObject({
        naTurmaHoje: false,
        base: 1,
      });
      expect(r.alunos.find((a) => a.alunoId === 'a1')?.naTurmaHoje).toBe(true);
    });

    // AC-005 — as duas metades, e elas não são simétricas.
    it('cancelada COM chamada conta; cancelada SEM chamada não aparece', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          ocupacoes: [
            ocorrencia('o1', 3),
            ocorrencia('o2', 2, { cancelada: true }),
            ocorrencia('o3', 1, { cancelada: true, completude: null }),
          ],
        }),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
      ]);

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.cobertura.aconteceram).toBe(2);
      expect(r.alunos[0].base).toBe(2);
    });

    // AC-013 — três números, não um. "Lançada" não equivale a "confiável".
    it('cobertura publica aconteceram, lancadas e completas separadamente', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          ocupacoes: [
            ocorrencia('o1', 4),
            ocorrencia('o2', 3, { completude: 'desconhecida' }),
            ocorrencia('o3', 2, { completude: null, presencas: 0 }),
          ],
        }),
      );

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.cobertura).toMatchObject({
        aconteceram: 3,
        lancadas: 2,
        completas: 1,
      });
    });

    // AC-014 — o contra-exemplo que derrubou a versão anterior: chamada
    // parcial em todas as aulas dava cobertura cheia e liberava o
    // percentual sobre base furada.
    it('cobertura abaixo do piso suprime o percentual e marca confiança baixa', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          ocupacoes: [
            ocorrencia('o1', 4, { completude: 'desconhecida' }),
            ocorrencia('o2', 3, { completude: 'desconhecida' }),
            ocorrencia('o3', 2, { completude: 'completa' }),
          ],
        }),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
      ]);

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.cobertura.confianca).toBe('baixa');
      expect(r.alunos[0].frequenciaPct).toBeNull();
      // A base continua publicada: suprimir o percentual não é esconder o
      // dado, é não afirmar o que ele não sustenta.
      expect(r.alunos[0].base).toBe(2);
    });

    // AC-016 — o defeito mais caro: conclusão errada a partir de dado
    // certo. Sem texto, `completas: 0` vira "ninguém lançou chamada".
    it('período com completude desconhecida vem com aviso em texto', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          ocupacoes: [ocorrencia('o1', 3, { completude: 'desconhecida' })],
        }),
      );

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.cobertura.aviso).toContain('completude');
      expect(r.cobertura.aviso).toContain('1 de 1');
    });

    // AC-006 — pela data da AULA, não pela ordem de gravação: o professor
    // lança a chamada de terça antes da de segunda o tempo todo.
    it('faltas seguidas contam da aula mais recente e param no primeiro presente', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          ocupacoes: [
            ocorrencia('o1', 9),
            ocorrencia('o2', 6),
            ocorrencia('o3', 3),
          ],
        }),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'justificado'), ocupacaoId: 'o3' },
      ]);

      const r = await service.daTurma('c1', 't1', 30);

      expect(r.alunos[0]).toMatchObject({
        faltasSeguidas: 2,
        faltasSeguidasComposicao: { ausente: 1, justificado: 1 },
      });
    });

    // AC-011 — aparece marcado; quem usa a marca é a evasão.
    it('aluno inativo ou não aprovado aparece, com os sinalizadores', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(
        turma({
          alunos: [
            aluno('a1', 'Ana', { status: 'inativo', vinculo: 'pendente' }),
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

  // ================================================================
  describe('doAluno (TASK-002)', () => {
    const fichaDoAluno = (over: Record<string, unknown> = {}) => ({
      id: 'a1',
      status: 'ativo',
      vinculo: 'aprovado',
      usuario: { nome: 'Ana' },
      turmaAlunos: [{ turma: { id: 't1', nome: 'Turma 01' } }],
      ...over,
    });

    const comPresencas = (
      o: ReturnType<typeof ocorrencia>,
      status: string[],
    ) => ({ ...o, presencas: status.map((s) => ({ status: s })) });

    it('aluno de outra empresa devolve 404', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.doAluno('c1', 'a1', 30)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // AC-007 — o agregado nunca sai sozinho. Este é o caso que ele
    // esconderia: bem numa turma, sumido da outra, "mediano" no total.
    it('soma as turmas E publica a quebra, que é onde o caso aparece', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(
        fichaDoAluno({
          turmaAlunos: [
            { turma: { id: 't1', nome: 'Turma 01' } },
            { turma: { id: 't2', nome: 'Turma 02' } },
          ],
        }),
      );
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        comPresencas(ocorrencia('o1', 5, { turmaId: 't1' }), ['presente']),
        comPresencas(ocorrencia('o2', 4, { turmaId: 't1' }), ['presente']),
        comPresencas(
          ocorrencia('o3', 3, { turmaId: 't2', turmaNome: 'Turma 02' }),
          ['ausente'],
        ),
        comPresencas(
          ocorrencia('o4', 2, { turmaId: 't2', turmaNome: 'Turma 02' }),
          ['ausente'],
        ),
      ]);

      const r = await service.doAluno('c1', 'a1', 30);

      expect(r.agregado).toMatchObject({ frequenciaPct: 50, base: 4 });
      expect(r.porTurma.find((t) => t.turmaId === 't1')).toMatchObject({
        frequenciaPct: 100,
      });
      expect(r.porTurma.find((t) => t.turmaId === 't2')).toMatchObject({
        frequenciaPct: 0,
        faltasSeguidas: 2,
      });
    });

    it('turma de que o aluno saiu continua na quebra, com naTurmaHoje false', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(fichaDoAluno());
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        comPresencas(ocorrencia('o1', 5, { turmaId: 't1' }), ['presente']),
        comPresencas(
          ocorrencia('o2', 4, { turmaId: 't9', turmaNome: 'Turma Antiga' }),
          ['ausente'],
        ),
      ]);

      const r = await service.doAluno('c1', 'a1', 30);

      expect(r.porTurma.find((t) => t.turmaId === 't9')).toMatchObject({
        naTurmaHoje: false,
        turmaNome: 'Turma Antiga',
      });
    });

    it('aluno sem registro nenhum: agregado null e a turma na quebra', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(fichaDoAluno());

      const r = await service.doAluno('c1', 'a1', 30);

      expect(r.agregado).toMatchObject({ frequenciaPct: null, base: 0 });
      expect(r.porTurma).toHaveLength(1);
    });

    it('ocorrências saem da mais recente para trás', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(fichaDoAluno());
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        comPresencas(ocorrencia('o1', 9, { turmaId: 't1' }), ['presente']),
        comPresencas(ocorrencia('o2', 2, { turmaId: 't1' }), ['ausente']),
        comPresencas(ocorrencia('o3', 5, { turmaId: 't1' }), ['presente']),
      ]);

      const r = await service.doAluno('c1', 'a1', 30);

      const datas = r.ocorrencias.map((o) => o.data);
      expect([...datas].sort().reverse()).toEqual(datas);
    });
  });

  // ================================================================
  describe('evasao (TASK-003)', () => {
    const comAluno = (o: ReturnType<typeof ocorrencia>, ocupacaoId = o.id) => ({
      ocupacaoId,
      ...o,
    });
    void comAluno;

    // AC-008 — a forma vazia existe para o dashboard sempre desenhar o
    // cartão. Um 404 por ausência de problema viraria erro na tela.
    it('empresa sem ninguém em risco devolve total 0 e lista vazia', async () => {
      const r = await service.evasao('c1', 30);
      expect(r).toMatchObject({ total: 0, alunos: [] });
    });

    // INV-023 (i)
    it('3 não-comparecimentos seguidos entram por faltas_seguidas', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        ocorrencia('o1', 5),
        ocorrencia('o2', 4),
        ocorrencia('o3', 3),
      ]);
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'justificado'), ocupacaoId: 'o2' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o3' },
      ]);

      const r = await service.evasao('c1', 30);

      expect(r.total).toBe(1);
      expect(r.alunos[0]).toMatchObject({
        alunoId: 'a1',
        turmaId: 't1',
        motivo: 'faltas_seguidas',
        faltasSeguidas: 3,
        // A composição existe para a UI não transformar o alerta em
        // verdade absoluta.
        faltasSeguidasComposicao: { ausente: 2, justificado: 1 },
      });
    });

    // INV-023 (ii) — base mínima de 4 é o que impede alarme sobre 1 aula.
    it('frequência abaixo de 60% com base >= 4 entra por frequencia_baixa', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue(
        [1, 2, 3, 4].map((n) => ocorrencia(`o${n}`, n + 1)),
      );
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o3' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o4' },
      ]);

      const r = await service.evasao('c1', 30);

      expect(r.alunos[0]).toMatchObject({
        motivo: 'frequencia_baixa',
        frequenciaPct: 50,
        base: 4,
      });
    });

    it('base menor que a mínima não vira alerta', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        ocorrencia('o1', 3),
        ocorrencia('o2', 2),
      ]);
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o1' },
        { ...presenca('a1', 'Ana', 'presente'), ocupacaoId: 'o2' },
      ]);

      const r = await service.evasao('c1', 30);

      expect(r.total).toBe(0);
    });

    // AC-011 — poluir o alerta com quem já saiu faz o gestor parar de
    // olhar o alerta.
    it('aluno inativo ou não aprovado fica FORA da evasão', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        ocorrencia('o1', 5),
        ocorrencia('o2', 4),
        ocorrencia('o3', 3),
      ]);
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue(
        ['o1', 'o2', 'o3'].map((id) => ({
          ...presenca('a1', 'Ana', 'ausente', { status: 'inativo' }),
          ocupacaoId: id,
        })),
      );

      const r = await service.evasao('c1', 30);

      expect(r.total).toBe(0);
    });

    // AC-014 — a assimetria: três não-comparecimentos são três,
    // independentemente de quantas aulas deixaram de ser lançadas. O
    // percentual, não.
    it('com confiança baixa, faltas seguidas ainda alerta e percentual não', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        ocorrencia('o1', 6, { completude: 'desconhecida' }),
        ocorrencia('o2', 5, { completude: 'desconhecida' }),
        ocorrencia('o3', 4, { completude: 'desconhecida' }),
        ocorrencia('o4', 3, { completude: 'completa' }),
      ]);
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        // a1: 3 faltas seguidas -> alerta mesmo com confiança baixa
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o2' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o3' },
        { ...presenca('a1', 'Ana', 'ausente'), ocupacaoId: 'o4' },
        // a2: 50% em base 4 -> NÃO alerta, porque a base é furada
        { ...presenca('a2', 'Bia', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a2', 'Bia', 'ausente'), ocupacaoId: 'o2' },
        { ...presenca('a2', 'Bia', 'presente'), ocupacaoId: 'o3' },
        { ...presenca('a2', 'Bia', 'ausente'), ocupacaoId: 'o4' },
      ]);

      const r = await service.evasao('c1', 30);

      expect(r.total).toBe(1);
      expect(r.alunos[0]).toMatchObject({
        alunoId: 'a1',
        motivo: 'faltas_seguidas',
        confianca: 'baixa',
        frequenciaPct: null,
      });
    });

    // AC-008 — faltas seguidas desc, depois frequência asc.
    it('ordena por faltas seguidas desc, depois frequência asc', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue(
        [1, 2, 3, 4, 5].map((n) => ocorrencia(`o${n}`, n + 1)),
      );
      const linhas = [
        // Ana: 5 faltas seguidas
        ...['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => ({
          ...presenca('a1', 'Ana', 'ausente'),
          ocupacaoId: id,
        })),
        // Bia: 3 seguidas (as mais recentes), 40%
        { ...presenca('a2', 'Bia', 'presente'), ocupacaoId: 'o1' },
        { ...presenca('a2', 'Bia', 'presente'), ocupacaoId: 'o2' },
        { ...presenca('a2', 'Bia', 'ausente'), ocupacaoId: 'o3' },
        { ...presenca('a2', 'Bia', 'ausente'), ocupacaoId: 'o4' },
        { ...presenca('a2', 'Bia', 'ausente'), ocupacaoId: 'o5' },
      ];
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue(linhas);

      const r = await service.evasao('c1', 30);

      expect(r.alunos.map((a) => a.alunoId)).toEqual(['a1', 'a2']);
      expect(r.alunos[0].faltasSeguidas).toBeGreaterThan(
        r.alunos[1].faltasSeguidas,
      );
    });
  });
});

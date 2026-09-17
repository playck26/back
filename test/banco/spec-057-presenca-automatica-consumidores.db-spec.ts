/**
 * SPEC-057/TASK-001 (card 5361) — **correção, consumidores e frequência.**
 *
 * - AC-005 — a exceção estreita do `nao_houve` sobre automática não ratificada,
 *   a janela de sete dias desde o fechamento, e a corrida revisão × exceção
 *   nas duas ordens (D5);
 * - AC-006 — o `PUT` ratifica, o gestor não ganha `PUT`, o legado continua
 *   `legada_humana`;
 * - AC-008 — `justificado` legado continua gravável pelo cliente antigo;
 * - AC-003 — `sem_participantes` igual nos cinco consumidores, pré-corte
 *   conserva a pendência;
 * - AC-010 — os cinco datasets do veredito v2 (A5/P06) com os dois braços da
 *   régua, a supressão por preenchimento baixo e as origens somando
 *   `aconteceram`.
 *
 * Serviços pela conexão do login runtime, como na suíte do worker.
 */
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import {
  garantirConexoesDeTeste,
  garantirLoginsDeTeste,
  ligarPresencaAutomatica,
  redefinirConfigDePresenca,
} from './config-de-presenca';
import {
  EMPRESA,
  TURMA_A,
  TURMA_ORIGEM,
  TURMA_VAZIA,
  UGESTOR,
  UPROF,
  UPROF_VAZIA,
  aluno,
  aula,
  cabecalhoDe,
  chamadaCrua,
  codigoDe,
  db,
  desconectarTodos,
  diasAtras,
  emDias,
  linhasDe,
  matricular,
  montarEmpresa,
  reiniciarSequencias,
  runtime,
  visita,
} from './presenca-automatica-fixture';
import { AgendaDoProfessorService } from '../../src/classes/agenda-do-professor.service';
import { PresencaService } from '../../src/classes/presenca.service';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import { FrequenciaService } from '../../src/frequencia/frequencia.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const app = runtime as unknown as PrismaService;
const presenca = () => new PresencaService(app);
const agenda = () => new AgendaDoProfessorService(app);
const frequencia = () => new FrequenciaService(app);
const worker = () => new FechamentoAutomaticoService(app);

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
  await garantirConexoesDeTeste(db);
});

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  reiniciarSequencias();
  await montarEmpresa();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await desconectarTodos();
});

/** TURMA_A com dois alunos, aula ontem fechada pelo job; corte há 3 dias. */
async function automaticaDeOntem() {
  const a1 = await aluno('Ana');
  const a2 = await aluno('Bruno');
  await matricular(TURMA_A, a1.alunoId);
  await matricular(TURMA_A, a2.alunoId);
  const oc = await aula(TURMA_A, -1);
  await ligarPresencaAutomatica(db, diasAtras(3));
  await worker().executarTick();
  expect(await cabecalhoDe(oc)).toMatchObject({ origem: 'automatica' });
  return { a1, a2, oc };
}

const todosPresentes = (ids: string[]) =>
  ids.map((alunoId) => ({ alunoId, status: 'presente' as const }));

// ======================================================================
describe('AC-005 — a exceção estreita do `nao_houve` (D5)', () => {
  it.each([
    ['professor', UPROF, true],
    ['gestor', UGESTOR, false],
  ] as const)(
    '%s sobre automática não ratificada: apaga as presumidas e grava nao_houve com origem inicial preservada',
    async (origem, usuario, comoProfessor) => {
      const { oc } = await automaticaDeOntem();
      const fechada = (await cabecalhoDe(oc))?.fechada;

      await presenca().registrarNaoHouve(EMPRESA, oc, usuario, comoProfessor);

      expect(await linhasDe(oc)).toHaveLength(0);
      const cab = await cabecalhoDe(oc);
      expect(cab).toMatchObject({
        completude: 'nao_houve',
        origem,
        origemInicial: 'automatica',
        registradaPor: usuario,
      });
      expect(cab?.fechada?.getTime()).toBe(fechada?.getTime());
    },
  );

  it('automática RATIFICADA: 422 CHAMADA_COM_PRESENCA, nada apagado', async () => {
    const { a1, a2, oc } = await automaticaDeOntem();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    await presenca().salvarChamada(
      EMPRESA,
      UPROF,
      oc,
      lida.versao,
      todosPresentes([a1.alunoId, a2.alunoId]),
    );

    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('CHAMADA_COM_PRESENCA');
    expect(await linhasDe(oc)).toHaveLength(2);
  });

  it('humana com presença continua 422 (LIM-030d de sempre)', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);
    await chamadaCrua(oc, 'professor', [[a1.alunoId, 'presente']]);

    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('CHAMADA_COM_PRESENCA');
  });

  it('fechada há mais de 7 dias: nao_houve E PUT recebem 422 AULA_ANTIGA — mesmo com a aula de ontem', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);
    await chamadaCrua(oc, 'automatica', [[a1.alunoId, 'presente']], {
      fechadaSql: "clock_timestamp() - interval '7 days 1 minute'",
    });

    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    expect(
      await codigoDe(
        presenca().salvarChamada(
          EMPRESA,
          UPROF,
          oc,
          lida.versao,
          todosPresentes([a1.alunoId]),
        ),
      ),
    ).toBe('AULA_ANTIGA');
  });

  it('ratificada continua corrigível pelo PUT até 7 dias do fechamento, mesmo com a aula antiga', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -9);
    // Nasceu automática há 6 dias e já foi ratificada.
    await chamadaCrua(oc, 'automatica', [[a1.alunoId, 'presente']], {
      fechadaSql: "clock_timestamp() - interval '6 days'",
    });
    await db.$executeRawUnsafe(
      `UPDATE chamadas SET origem = 'professor', registrada_por = '${UPROF}' WHERE ocupacao_id = '${oc}'`,
    );
    await db.$executeRawUnsafe(
      `UPDATE presencas SET registrado_por = '${UPROF}' WHERE ocupacao_id = '${oc}'`,
    );

    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    expect(
      await codigoDe(
        presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
          { alunoId: a1.alunoId, status: 'ausente' },
        ]),
      ),
    ).toBe('ok');
  });

  it('aula cancelada: 422 AULA_CANCELADA, e cancelar não apagou presença (INV-025)', async () => {
    const { oc } = await automaticaDeOntem();
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: oc,
      autorId: UGESTOR,
    });

    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_CANCELADA');
    expect(await linhasDe(oc)).toHaveLength(2);
  });

  it('corrida, ordem 1: revisão vence → exceção recebe 422', async () => {
    const { a1, a2, oc } = await automaticaDeOntem();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);

    await presenca().salvarChamada(
      EMPRESA,
      UPROF,
      oc,
      lida.versao,
      todosPresentes([a1.alunoId, a2.alunoId]),
    );
    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UGESTOR, false)),
    ).toBe('CHAMADA_COM_PRESENCA');
  });

  it('corrida, ordem 2: exceção vence → PUT com a versão velha recebe 409', async () => {
    const { a1, a2, oc } = await automaticaDeOntem();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);

    await presenca().registrarNaoHouve(EMPRESA, oc, UGESTOR, false);
    expect(
      await codigoDe(
        presenca().salvarChamada(
          EMPRESA,
          UPROF,
          oc,
          lida.versao,
          todosPresentes([a1.alunoId, a2.alunoId]),
        ),
      ),
    ).toBe('CHAMADA_DESATUALIZADA');
  });

  it('corrida simultânea: exatamente um dos dois desfechos da D5', async () => {
    const { a1, a2, oc } = await automaticaDeOntem();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);

    const [put, excecao] = await Promise.all([
      codigoDe(
        presenca().salvarChamada(
          EMPRESA,
          UPROF,
          oc,
          lida.versao,
          todosPresentes([a1.alunoId, a2.alunoId]),
        ),
      ),
      codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UGESTOR, false)),
    ]);

    expect([
      ['ok', 'CHAMADA_COM_PRESENCA'],
      ['CHAMADA_DESATUALIZADA', 'ok'],
    ]).toContainEqual([put, excecao]);
  });
});

// ======================================================================
describe('AC-006 — ratificação e proveniência', () => {
  it('o gestor não ganha PUT de chamada', async () => {
    const { a1, a2, oc } = await automaticaDeOntem();
    const lida = await presenca().chamada(EMPRESA, UPROF, oc);

    expect(
      await codigoDe(
        presenca().salvarChamada(
          EMPRESA,
          UGESTOR,
          oc,
          lida.versao,
          todosPresentes([a1.alunoId, a2.alunoId]),
        ),
      ),
    ).toBe('ForbiddenException');
    expect(await cabecalhoDe(oc)).toMatchObject({ origem: 'automatica' });
  });

  it('cabeçalho do binário antigo nasce legada_humana e continua assim como origem inicial depois do PUT', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);
    await chamadaCrua(oc, 'antigo', [[a1.alunoId, 'presente']]);
    expect(await cabecalhoDe(oc)).toMatchObject({
      origem: 'legada_humana',
      origemInicial: 'legada_humana',
    });

    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    await presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
      { alunoId: a1.alunoId, status: 'ausente' },
    ]);

    expect(await cabecalhoDe(oc)).toMatchObject({
      origem: 'professor',
      origemInicial: 'legada_humana',
      fechada: null,
    });
  });

  it('chamada humana nova nasce professor/professor e nunca vira automática pelo serviço', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));

    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    await presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
      { alunoId: a1.alunoId, status: 'presente' },
    ]);
    await worker().executarTick();

    expect(await cabecalhoDe(oc)).toMatchObject({
      origem: 'professor',
      origemInicial: 'professor',
      registradaPor: UPROF,
      fechada: null,
    });
  });
});

// ======================================================================
describe('AC-008 — `justificado` legado', () => {
  it('o cliente antigo ainda grava `justificado`, e ele volta na leitura', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const oc = await aula(TURMA_A, -1);

    const lida = await presenca().chamada(EMPRESA, UPROF, oc);
    await presenca().salvarChamada(EMPRESA, UPROF, oc, lida.versao, [
      { alunoId: a1.alunoId, status: 'justificado' },
    ]);

    const relida = await presenca().chamada(EMPRESA, UPROF, oc);
    expect(relida.alunos[0].status).toBe('justificado');
  });
});

// ======================================================================
describe('AC-003 — `sem_participantes` nos cinco consumidores', () => {
  /** Os cinco consumidores lendo a mesma ocorrência da TURMA_VAZIA. */
  async function osCinco(oc: string, dias: number) {
    const data = emDias(dias);
    const mes = await agenda().resumoDoMes(
      EMPRESA,
      UPROF_VAZIA,
      data.slice(0, 7),
    );
    const dia = await agenda().detalheDoDia(EMPRESA, UPROF_VAZIA, data);
    const lista = await presenca().ocorrenciasDaTurma(
      EMPRESA,
      UPROF_VAZIA,
      TURMA_VAZIA,
      30,
    );
    const historico = await presenca().historicoDaTurma(
      EMPRESA,
      TURMA_VAZIA,
      30,
    );
    const freq = await frequencia().daTurma(EMPRESA, TURMA_VAZIA, 30);
    return {
      mes: mes.find((m) => m.data === data),
      dia: dia.find((d) => d.ocupacaoId === oc)?.chamada,
      lista: lista.data.find((o) => o.ocupacaoId === oc)?.estado,
      historico: historico.find((o) => o.ocupacaoId === oc)?.estado,
      aconteceram: freq.cobertura.aconteceram,
    };
  }

  it('vazia pós-corte: estado nos cinco, zero pendência, aula no total, fora do denominador, sem cabeçalho', async () => {
    const oc = await aula(TURMA_VAZIA, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await worker().executarTick();

    const r = await osCinco(oc, -1);

    expect(r.mes).toMatchObject({ aulas: 1, turmas: 1, pendentes: 0 });
    expect(r.dia).toBe('sem_participantes');
    expect(r.lista).toBe('sem_participantes');
    expect(r.historico).toBe('sem_participantes');
    expect(r.aconteceram).toBe(0);
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('vazia PRÉ-corte conserva a regra legada: pendente nos cinco', async () => {
    const oc = await aula(TURMA_VAZIA, -5);
    await ligarPresencaAutomatica(db, diasAtras(3));

    const r = await osCinco(oc, -5);

    expect(r.mes).toMatchObject({ aulas: 1, pendentes: 1 });
    expect(r.dia).toBe('pendente');
    expect(r.lista).toBe('pendente');
    expect(r.historico).toBe('pendente');
    expect(r.aconteceram).toBe(1);
  });

  it('ambiente que nunca ativou: vazia continua pendente', async () => {
    const oc = await aula(TURMA_VAZIA, -1);

    const r = await osCinco(oc, -1);

    expect(r.dia).toBe('pendente');
    expect(r.aconteceram).toBe(1);
  });

  it('só visitante: não é vazia — o job fecha com ele', async () => {
    const oc = await aula(TURMA_VAZIA, -1);
    const visitante = await aluno('Visitante');
    await matricular(TURMA_ORIGEM, visitante.alunoId);
    await visita(visitante.alunoId, oc);
    await ligarPresencaAutomatica(db, diasAtras(3));

    expect((await osCinco(oc, -1)).dia).toBe('pendente');
    await worker().executarTick();

    const r = await osCinco(oc, -1);
    expect(r.dia).toBe('feita');
    expect(r.historico).toBe('feita');
    expect(await linhasDe(oc)).toHaveLength(1);
  });

  it('mudança de matrícula antes do tick: vazia vira pendente ao ganhar aluno', async () => {
    const oc = await aula(TURMA_VAZIA, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    expect((await osCinco(oc, -1)).dia).toBe('sem_participantes');

    const a1 = await aluno('Ana');
    await matricular(TURMA_VAZIA, a1.alunoId);

    const r = await osCinco(oc, -1);
    expect(r.dia).toBe('pendente');
    expect(r.lista).toBe('pendente');
    expect(r.mes).toMatchObject({ pendentes: 1 });
  });

  it('cabeçalho salvo manda: turma esvaziada depois continua `feita`', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_VAZIA, a1.alunoId);
    const oc = await aula(TURMA_VAZIA, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await worker().executarTick();
    await db.$executeRawUnsafe(
      `DELETE FROM turma_alunos WHERE turma_id = '${TURMA_VAZIA}'`,
    );

    const r = await osCinco(oc, -1);
    expect(r.dia).toBe('feita');
    expect(r.historico).toBe('feita');
    expect(r.aconteceram).toBe(1);
  });
});

// ======================================================================
describe('AC-010 — os cinco datasets do veredito v2 (A5/P06)', () => {
  type Linha = 'A' | 'P' | 'auto' | '-';
  const datasets: {
    nome: string;
    linhas: Linha[];
    preenchimento: number;
    base: number;
    frequencia: number | null;
    sequencia: number;
    evasao: string | null;
    origens: Record<string, number>;
  }[] = [
    {
      nome: '3 ausências + 5 sem cabeçalho',
      linhas: ['A', 'A', 'A', '-', '-', '-', '-', '-'],
      preenchimento: 37.5,
      base: 3,
      frequencia: null,
      sequencia: 3,
      evasao: 'faltas_seguidas',
      origens: { humanas: 3, pendentesAtuais: 5 },
    },
    {
      nome: '3 ausências + 5 automáticas',
      linhas: ['A', 'A', 'A', 'auto', 'auto', 'auto', 'auto', 'auto'],
      preenchimento: 100,
      base: 8,
      frequencia: 62.5,
      sequencia: 0,
      evasao: null,
      origens: { humanas: 3, automaticas: 5 },
    },
    {
      nome: '5 automáticas + 3 ausências',
      linhas: ['auto', 'auto', 'auto', 'auto', 'auto', 'A', 'A', 'A'],
      preenchimento: 100,
      base: 8,
      frequencia: 62.5,
      sequencia: 3,
      evasao: 'faltas_seguidas',
      origens: { humanas: 3, automaticas: 5 },
    },
    {
      nome: 'A,A,P,A,A,P,A,P',
      linhas: ['A', 'A', 'P', 'A', 'A', 'P', 'A', 'P'],
      preenchimento: 100,
      base: 8,
      frequencia: 37.5,
      sequencia: 0,
      evasao: 'frequencia_baixa',
      origens: { humanas: 8 },
    },
    {
      nome: '3 automáticas + 5 sem cabeçalho',
      linhas: ['auto', 'auto', 'auto', '-', '-', '-', '-', '-'],
      preenchimento: 37.5,
      base: 3,
      frequencia: null,
      sequencia: 0,
      evasao: null,
      origens: { automaticas: 3, pendentesAtuais: 5 },
    },
  ];

  it.each(datasets)('$nome', async (d) => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    // Oito aulas, da mais antiga (-8) para a mais recente (-1), todas depois
    // do corte — as sem cabeçalho são pendência ATUAL, como no veredito.
    await ligarPresencaAutomatica(db, diasAtras(20));
    for (const [i, linha] of d.linhas.entries()) {
      const oc = await aula(TURMA_A, -8 + i);
      if (linha === 'auto') {
        await chamadaCrua(oc, 'automatica', [[a1.alunoId, 'presente']]);
      } else if (linha !== '-') {
        await chamadaCrua(oc, 'professor', [
          [a1.alunoId, linha === 'A' ? 'ausente' : 'presente'],
        ]);
      }
    }

    const turma = await frequencia().daTurma(EMPRESA, TURMA_A, 30);
    const evasao = await frequencia().evasao(EMPRESA, 30);

    expect(turma.cobertura.pctCompletas).toBe(d.preenchimento);
    expect(turma.alunos[0]).toMatchObject({
      base: d.base,
      frequenciaPct: d.frequencia,
      faltasSeguidas: d.sequencia,
    });
    expect(evasao.total).toBe(d.evasao ? 1 : 0);
    if (d.evasao) {
      expect(evasao.alunos[0]).toMatchObject({
        motivo: d.evasao,
        turmaId: TURMA_A,
      });
      expect(evasao.alunos[0].cobertura.origens).toEqual(
        turma.cobertura.origens,
      );
    }
    const origens = {
      automaticas: 0,
      ratificadas: 0,
      humanas: 0,
      pendentesLegadas: 0,
      pendentesAtuais: 0,
      ...d.origens,
    };
    expect(turma.cobertura.origens).toEqual(origens);
    const o = turma.cobertura.origens;
    const soma =
      o.automaticas +
      o.ratificadas +
      o.humanas +
      o.pendentesLegadas +
      o.pendentesAtuais;
    expect(soma).toBe(turma.cobertura.aconteceram);

    // O relatório do aluno traz a mesma cobertura e a origem por ocorrência.
    const doAluno = await frequencia().doAluno(EMPRESA, a1.alunoId, 30);
    expect(doAluno.porTurma[0].cobertura.origens).toEqual(origens);
    expect(
      doAluno.ocorrencias.filter((o) => o.origem === 'automatica'),
    ).toHaveLength(d.linhas.filter((l) => l === 'auto').length);
  });

  it('ratificada conta em `ratificadas`; pendência pré-corte em `pendentesLegadas`', async () => {
    const a1 = await aluno('Ana');
    await matricular(TURMA_A, a1.alunoId);
    const velha = await aula(TURMA_A, -6);
    const ratificada = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await worker().executarTick();
    const lida = await presenca().chamada(EMPRESA, UPROF, ratificada);
    await presenca().salvarChamada(EMPRESA, UPROF, ratificada, lida.versao, [
      { alunoId: a1.alunoId, status: 'presente' },
    ]);

    const turma = await frequencia().daTurma(EMPRESA, TURMA_A, 30);

    expect(await cabecalhoDe(velha)).toBeNull();
    expect(turma.cobertura.origens).toEqual({
      automaticas: 0,
      ratificadas: 1,
      humanas: 0,
      pendentesLegadas: 1,
      pendentesAtuais: 0,
    });
  });
});

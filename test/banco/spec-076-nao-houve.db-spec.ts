/**
 * SPEC-076/TASK-003 — **"a aula não aconteceu" continua para os dois, e se
 * desfaz por rota própria, idempotente, sem renovar a janela, num relógio só**
 * (D3, D11; AC-008 a AC-013 e AC-030).
 *
 * O serviço roda pela conexão do login runtime, com o `RelogioDaPresenca`
 * **substituído por um relógio controlado** onde a prova depende do tempo
 * (AC-009 iii, AC-013): o portão lê `agora` uma vez, desse provedor, e decide
 * em TypeScript. O instante do FECHAMENTO continua sendo o do banco — é o
 * worker real que fecha.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';
import { chamadasDoCorpo, corpoDoMetodo, sqlDoCorpo } from './corpo-do-portao';
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
  UGESTOR,
  UPROF,
  UPROF_VAZIA,
  aluno,
  aula,
  cabecalhoDe,
  codigoDe,
  db,
  desconectarTodos,
  diasAtras,
  linhasDe,
  matricular,
  montarEmpresa,
  q,
  reiniciarSequencias,
  runtime,
} from './presenca-automatica-fixture';
import {
  PresencaService,
  limiteDoDesfazerNaoHouve,
} from '../../src/classes/presenca.service';
import { RelogioDaPresenca } from '../../src/classes/relogio-da-presenca';
import { CorteDaPresenca } from '../../src/presenca-automatica/corte-da-presenca';
import { FechamentoAutomaticoService } from '../../src/presenca-automatica/fechamento-automatico.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const app = runtime as unknown as PrismaService;

/** O relógio do portão, parado onde o teste mandar; sem ordem, o do banco. */
class RelogioControlado extends RelogioDaPresenca {
  instante: Date | null = null;
  override async agora(
    db2: Parameters<RelogioDaPresenca['agora']>[0],
  ): Promise<Date> {
    return this.instante ?? super.agora(db2);
  }
}

let relogio: RelogioControlado;
const presenca = () =>
  new PresencaService(app, new CorteDaPresenca(app), relogio);
const worker = () => new FechamentoAutomaticoService(app);

const MS_DIA = 24 * 60 * 60 * 1000;

const avisar = (alunoId: string, ocupacaoId: string) =>
  q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );

/** Linhas completas da ocorrência, para comparar ANTES e DEPOIS (não contagem). */
const fotografia = async (oc: string) =>
  JSON.stringify(
    await db.$queryRawUnsafe(
      `SELECT (SELECT row_to_json(c) FROM chamadas c WHERE c.ocupacao_id = $1::uuid) AS cab,
              (SELECT json_agg(p ORDER BY p.aluno_id) FROM presencas p WHERE p.ocupacao_id = $1::uuid) AS linhas`,
      oc,
    ),
  );

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
  await garantirConexoesDeTeste(db);
});

beforeEach(async () => {
  relogio = new RelogioControlado();
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

/** M = {a, b} em TURMA_A, b avisou falta, aula ontem fechada pelo worker. */
async function automaticaComFalta() {
  const a = await aluno('Ana');
  const b = await aluno('Bruno');
  await matricular(TURMA_A, a.alunoId);
  await matricular(TURMA_A, b.alunoId);
  const oc = await aula(TURMA_A, -1);
  await avisar(b.alunoId, oc);
  await ligarPresencaAutomatica(db, diasAtras(3));
  await worker().executarTick();
  const cab = await cabecalhoDe(oc);
  expect(cab).toMatchObject({ origem: 'automatica', completude: 'completa' });
  return { a, b, oc, fechada: cab?.fechada as Date };
}

const statusPorAluno = async (oc: string) =>
  Object.fromEntries((await linhasDe(oc)).map((l) => [l.alunoId, l.status]));

describe('AC-008 — registrar sobre automática apaga `presente` E `ausente`', () => {
  it.each([
    ['professor', UPROF, true],
    ['gestor', UGESTOR, false],
  ] as const)('%s', async (_nome, usuario, comoProfessor) => {
    const { a, b, oc } = await automaticaComFalta();
    expect(await statusPorAluno(oc)).toEqual({
      [a.alunoId]: 'presente',
      [b.alunoId]: 'ausente',
    });

    await presenca().registrarNaoHouve(
      EMPRESA,
      oc,
      usuario,
      comoProfessor,
      comoProfessor ? undefined : TURMA_A,
    );

    expect(await linhasDe(oc)).toHaveLength(0);
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });
});

describe('AC-009 — desfazer, pelo professor', () => {
  it('(i) nascido sobre automática: refecha NA HORA, com D2, autor nulo e o MESMO instante', async () => {
    const { a, b, oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r).toEqual({ ocupacaoId: oc, estado: 'feita' });
    expect(await statusPorAluno(oc)).toEqual({
      [a.alunoId]: 'presente',
      [b.alunoId]: 'ausente',
    });
    expect((await linhasDe(oc)).every((l) => l.autor === null)).toBe(true);
    const cab = await cabecalhoDe(oc);
    expect(cab).toMatchObject({
      completude: 'completa',
      origem: 'automatica',
      registradaPor: null,
    });
    expect(cab?.fechada?.getTime()).toBe(fechada.getTime());
  });

  it('(ii) nascido humano, pós-corte: o cabeçalho sai, o estado é `pendente`, e um tick o fecha', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    expect(await cabecalhoDe(oc)).toMatchObject({
      completude: 'nao_houve',
      fechada: null,
    });

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('pendente');
    expect(await cabecalhoDe(oc)).toBeNull();
    await worker().executarTick();
    expect(await cabecalhoDe(oc)).toMatchObject({
      completude: 'completa',
      origem: 'automatica',
    });
  });

  it('(iii) o laço NÃO estende a janela: dentro dela, registrar/desfazer em série passam; passado o prazo do FECHAMENTO, 422', async () => {
    const { oc, fechada } = await automaticaComFalta();

    relogio.instante = new Date(fechada.getTime() + 60 * 60 * 1000);
    for (let i = 0; i < 2; i += 1) {
      expect(
        await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
      ).toBe('ok');
      expect(
        await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
      ).toBe('ok');
    }
    // O instante é o do primeiro fechamento, e continua sendo.
    expect((await cabecalhoDe(oc))?.fechada?.getTime()).toBe(fechada.getTime());

    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA + 1000);
    expect(
      await codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
  });
});

describe('AC-010 — desfazer, pelo gestor', () => {
  it('desfaz pela rota aninhada, e `:turmaId` de outra turma é 404', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UGESTOR, false, TURMA_A);

    expect(
      await codigoDe(
        presenca().desfazerNaoHouve(
          EMPRESA,
          oc,
          UGESTOR,
          false,
          '05720000-0000-4000-8000-0000000000b1',
        ),
      ),
    ).toBe('NotFoundException');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');

    const r = await presenca().desfazerNaoHouve(
      EMPRESA,
      oc,
      UGESTOR,
      false,
      TURMA_A,
    );
    expect(r.estado).toBe('feita');
  });
});

describe('AC-011 — nao_houve ANTERIOR ao corte', () => {
  it('desfazer deixa `sem_registro`, e o worker não a fecha', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    // O corte vem DEPOIS da aula: ela é anterior à automação.
    await ligarPresencaAutomatica(db, new Date());

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('sem_registro');
    await worker().executarTick();
    expect(await cabecalhoDe(oc)).toBeNull();
  });
});

describe('AC-012 — idempotência que não destrói', () => {
  it('sobre chamada `completa`: 200, e as linhas idênticas antes e depois', async () => {
    const { oc } = await automaticaComFalta();
    const antes = await fotografia(oc);

    const r = await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(r.estado).toBe('feita');
    expect(await fotografia(oc)).toBe(antes);
  });

  it('o retry depois de o worker refechar um nao_houve humano é no-op', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await ligarPresencaAutomatica(db, diasAtras(3));
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);
    await worker().executarTick();
    const antes = await fotografia(oc);

    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);

    expect(await fotografia(oc)).toBe(antes);
  });
});

describe('AC-013 — o DELETE herda o portão', () => {
  it('AULA_CANCELADA', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: oc,
      autorId: UGESTOR,
    });
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_CANCELADA');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('AULA_FUTURA', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, 2);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_FUTURA');
  });

  it('AULA_ANTIGA pela janela RETROATIVA (nao_houve humano), pelo relógio controlado', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    relogio.instante = new Date(Date.now() + 8 * MS_DIA);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('AULA_ANTIGA pela janela da AUTOMÁTICA, pelo relógio controlado', async () => {
    const { oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA + 1000);
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true)),
    ).toBe('AULA_ANTIGA');
  });

  it('404 para aula de outro professor', async () => {
    const { oc } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    expect(
      await codigoDe(
        presenca().desfazerNaoHouve(EMPRESA, oc, UPROF_VAZIA, true),
      ),
    ).toBe('NotFoundException');
  });

  it('403 para quem não é professor', async () => {
    const { oc } = await automaticaComFalta();
    expect(
      await codigoDe(presenca().desfazerNaoHouve(EMPRESA, oc, UGESTOR, true)),
    ).toBe('ForbiddenException');
  });
});

/**
 * AC-030, a prova de COMPORTAMENTO — **os outros relógios discordam de
 * propósito**, e a decisão do portão segue o injetado.
 *
 * A prova textual (abaixo) fecha o que dá para ler; a 3ª rodada da validação
 * mostrou que ler não fecha a classe: um alias de import e um helper externo
 * com relógio padrão passavam. Esta prova não lê código. Em cada cenário o
 * relógio do Node é falsificado (Date, hrtime, performance) num instante que
 * inverteria a decisão, e o do banco (o real) também discorda do injetado onde
 * isso é possível. Se QUALQUER outro relógio influir — por alias, helper,
 * chamada transitiva, `Intl`, `Reflect.construct(Date)`, `SELECT now()` —, a
 * decisão muda e o caso cai.
 *
 * **4ª rodada — a fronteira.** Cada janela do portão (a da automática, a
 * retroativa e o início da aula) é testada **colada na fronteira** (1 ms de um
 * lado, e o instante exato do outro), nas DUAS direções, com o relógio do Node
 * E o do banco do lado oposto ao injetado — o do banco, movendo o fechamento
 * para trás, porque ele não se deixa parar.
 *
 * **5ª rodada — a prova deixou de ser busca.** Um relógio por callback ou por
 * dependência, numa faixa que nenhum caso tocava, passou pelo vigia desta
 * suíte. O fechamento da classe agora é estrutural: a decisão de tempo é
 * `decidirTempoDoPortao`, provada num realm sem relógio com cobertura total
 * (`src/classes/tempo-do-portao.spec.ts`), e o corpo do portão só pode fazer
 * as chamadas de uma lista fechada (o `describe` do fim deste arquivo). Estes
 * casos continuam como prova de INTEGRAÇÃO: o `agora` que decide é o injetado.
 */
describe('AC-030 — os outros relógios discordam, e o portão segue o injetado', () => {
  /** Roda `fn` com o relógio do Node parado em `instante`; os timers ficam reais. */
  async function comNodeEm<T>(
    instante: Date,
    fn: () => Promise<T>,
  ): Promise<T> {
    jest.useFakeTimers({
      now: instante,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
      ],
    });
    try {
      // A falsificação pegou: sem isto, o caso passaria sem ter discordado.
      expect(Date.now()).toBe(instante.getTime());
      expect(new Date().getTime()).toBe(instante.getTime());
      return await fn();
    } finally {
      jest.useRealTimers();
    }
  }

  /** O portão decide com o Node em `nodeEm`; devolve `ok` ou o `code` do 422. */
  const decidir = (nodeEm: Date, oc: string): Promise<string> =>
    comNodeEm(nodeEm, () =>
      codigoDe(presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true)),
    );

  const HORA = { inicio: '10:00', fim: '10:50' };
  /** `aaaa-mm-dd` da aula, como o banco a guarda. */
  const dataDe = async (oc: string) => {
    const [linha] = await db.$queryRawUnsafe<{ data: Date }[]>(
      `SELECT data FROM ocupacoes_quadra WHERE id = $1::uuid`,
      oc,
    );
    return linha.data.toISOString().slice(0, 10);
  };
  const maisDias = (dia: string, n: number) =>
    new Date(Date.parse(`${dia}T00:00:00Z`) + n * MS_DIA)
      .toISOString()
      .slice(0, 10);
  /** O clube é UTC−3 o ano inteiro (sem horário de verão desde 2019). */
  const noClube = (dia: string, hora: string) =>
    new Date(`${dia}T${hora}:00.000-03:00`);

  /** Automática fechada pelo worker, de uma aula de 10 dias atrás. */
  async function automaticaDeAulaAntiga() {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -10, HORA);
    await ligarPresencaAutomatica(db, diasAtras(12));
    await worker().executarTick();
    const cab = await cabecalhoDe(oc);
    expect(cab).toMatchObject({ origem: 'automatica' });
    return oc;
  }

  /**
   * Leva o fechamento `dias` para trás, para o relógio do BANCO cair fora da
   * janela. O gatilho `chamadas_fechamento_imutavel` protege a coluna, e é
   * certo que proteja; a fixture o contorna só nesta transação.
   */
  async function recuarFechamento(oc: string, dias: number): Promise<Date> {
    await db.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await t.$executeRawUnsafe(
        `UPDATE chamadas SET fechada_automaticamente_em = fechada_automaticamente_em - make_interval(days => $2::int)
          WHERE ocupacao_id = $1::uuid`,
        oc,
        dias,
      );
    });
    const fechada = (await cabecalhoDe(oc))?.fechada as Date;
    // O banco, agora, está FORA da janela.
    const [{ fora }] = await db.$queryRawUnsafe<{ fora: boolean }[]>(
      `SELECT $1::timestamptz + interval '7 days' <= clock_timestamp() AS fora`,
      fechada,
    );
    expect(fora).toBe(true);
    return fechada;
  }

  // -- longe da fronteira (3ª rodada) ----------------------------------------

  it('automática DENTRO da janela pelo injetado, FORA pelo Node: aceita', async () => {
    const { oc, fechada } = await automaticaComFalta();
    relogio.instante = new Date(fechada.getTime() + 60 * 60 * 1000);
    expect(await decidir(new Date(fechada.getTime() + 30 * MS_DIA), oc)).toBe(
      'ok',
    );
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('automática FORA da janela pelo injetado, DENTRO pelo Node e pelo banco: AULA_ANTIGA', async () => {
    const { oc, fechada } = await automaticaComFalta();
    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA + 1000);
    expect(
      await decidir(new Date(fechada.getTime() + 60 * 60 * 1000), oc),
    ).toBe('AULA_ANTIGA');
    expect((await cabecalhoDe(oc))?.completude).toBe('completa');
  });

  it('retroativa VENCIDA pelo injetado, dentro pelo Node e pelo banco: AULA_ANTIGA', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    const real = new Date();
    relogio.instante = new Date(real.getTime() + 8 * MS_DIA);
    expect(await decidir(real, oc)).toBe('AULA_ANTIGA');
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('aula JÁ COMEÇADA pelo injetado, futura pelo Node e pelo banco: aceita', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, 2);
    const real = new Date();
    relogio.instante = new Date(real.getTime() + 3 * MS_DIA);
    expect(await decidir(real, oc)).toBe('ok');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  // -- COLADO na fronteira, nas duas direções (4ª rodada) --------------------

  it('automática, 1 ms ANTES do fim da janela pelo injetado; Node e banco já fora: aceita', async () => {
    const oc = await automaticaDeAulaAntiga();
    const fechada = await recuarFechamento(oc, 8);
    const fim = fechada.getTime() + 7 * MS_DIA;
    relogio.instante = new Date(fim - 1);
    expect(await decidir(new Date(fim + 30 * MS_DIA), oc)).toBe('ok');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('automática, NO instante do fim da janela pelo injetado; Node e banco ainda dentro: AULA_ANTIGA', async () => {
    const { oc, fechada } = await automaticaComFalta();
    relogio.instante = new Date(fechada.getTime() + 7 * MS_DIA);
    expect(
      await decidir(new Date(fechada.getTime() + 60 * 60 * 1000), oc),
    ).toBe('AULA_ANTIGA');
    expect((await cabecalhoDe(oc))?.completude).toBe('completa');
  });

  it('retroativa, 1 ms ANTES da meia-noite de data+8 pelo injetado; Node e banco já fora: aceita', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -10, HORA);
    const fim = noClube(maisDias(await dataDe(oc), 8), '00:00').getTime();
    // O relógio real (o do banco) já passou do fim: a aula tem 10 dias.
    expect(Date.now()).toBeGreaterThan(fim);
    relogio.instante = new Date(fim - 1);
    expect(await decidir(new Date(fim + 30 * MS_DIA), oc)).toBe('ok');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });

  it('retroativa, NA meia-noite de data+8 pelo injetado; Node e banco ainda dentro: AULA_ANTIGA', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1, HORA);
    const fim = noClube(maisDias(await dataDe(oc), 8), '00:00');
    expect(Date.now()).toBeLessThan(fim.getTime());
    relogio.instante = fim;
    expect(await decidir(new Date(), oc)).toBe('AULA_ANTIGA');
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('início da aula, 1 ms ANTES pelo injetado; Node e banco já depois: AULA_FUTURA', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1, HORA);
    const inicio = noClube(await dataDe(oc), HORA.inicio).getTime();
    expect(Date.now()).toBeGreaterThan(inicio);
    relogio.instante = new Date(inicio - 1);
    expect(await decidir(new Date(inicio + 30 * MS_DIA), oc)).toBe(
      'AULA_FUTURA',
    );
    expect(await cabecalhoDe(oc)).toBeNull();
  });

  it('início da aula, NO instante pelo injetado; Node e banco ainda antes: aceita', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, 2, HORA);
    const inicio = noClube(await dataDe(oc), HORA.inicio);
    expect(Date.now()).toBeLessThan(inicio.getTime());
    relogio.instante = inicio;
    expect(await decidir(new Date(), oc)).toBe('ok');
    expect((await cabecalhoDe(oc))?.completude).toBe('nao_houve');
  });
});

describe('D3 — `desfazerNaoHouveAte` no GET e no histórico', () => {
  it('automática: fechamento + 7 dias; depois de desfeito, nulo', async () => {
    const { oc, fechada } = await automaticaComFalta();
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);

    const esperado = new Date(fechada.getTime() + 7 * MS_DIA).toISOString();
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBe(esperado);
    expect(
      (await presenca().historicoDaTurma(EMPRESA, TURMA_A, 30)).find(
        (o) => o.ocupacaoId === oc,
      )?.desfazerNaoHouveAte,
    ).toBe(esperado);

    await presenca().desfazerNaoHouve(EMPRESA, oc, UPROF, true);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });

  it('humano: meia-noite do dia `data + 8` no fuso do clube; fora dele, nulo', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    await presenca().registrarNaoHouve(EMPRESA, oc, UPROF, true);
    const [linha] = await db.$queryRawUnsafe<{ data: Date }[]>(
      `SELECT data FROM ocupacoes_quadra WHERE id = $1::uuid`,
      oc,
    );
    const esperado = limiteDoDesfazerNaoHouve(
      { completude: 'nao_houve', fechadaAutomaticamenteEm: null },
      linha.data,
      new Date(0),
    );
    // Meia-noite no clube (UTC−3) é 03:00Z do dia `data + 8`.
    const d8 = new Date(linha.data.getTime() + 8 * MS_DIA);
    expect(esperado).toBe(`${d8.toISOString().slice(0, 10)}T03:00:00.000Z`);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBe(esperado);

    relogio.instante = new Date(new Date(esperado as string).getTime() + 1000);
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });

  it('sem nao_houve, nulo', async () => {
    const { oc } = await automaticaComFalta();
    expect(
      (await presenca().chamada(EMPRESA, UPROF, oc)).desfazerNaoHouveAte,
    ).toBeNull();
  });
});

describe('AC-030 — a produção lê o relógio do BANCO, e o portão tem um relógio só', () => {
  it('o `RelogioDaPresenca` real difere do `clock_timestamp()` da mesma transação em menos de 1 s', async () => {
    const real = new RelogioDaPresenca();
    await db.$transaction(async (tx) => {
      const agora = await real.agora(tx);
      const [linha] = await tx.$queryRawUnsafe<{ t: Date }[]>(
        `SELECT clock_timestamp() AS t`,
      );
      expect(Math.abs(linha.t.getTime() - agora.getTime())).toBeLessThan(1000);
    });
  });

  it('o corpo de `travarEValidarOcorrencia` só faz as chamadas de uma lista FECHADA', () => {
    // Lista do que PODE, e não do que não pode: a 5ª rodada mostrou que a
    // busca por relógio não termina (callback, dependência). Qualquer chamada
    // nova no portão — de pacote, de callback, de ORM, de helper — muda esta
    // lista e derruba o teste, qualquer que seja a forma; quem a mudar tem de
    // mostrar que ela não traz relógio. A leitura do relógio é UMA
    // (`this.relogio.agora`) e a decisão de tempo é `decidirTempoDoPortao`,
    // provada num realm sem relógio (`tempo-do-portao.spec.ts`).
    const servico = join(SRC_CLASSES, 'presenca.service.ts');
    const { codigo, estrutura } = corpoDoMetodo(
      servico,
      'travarEValidarOcorrencia',
    );
    expect(chamadasDoCorpo(estrutura)).toEqual([
      'tx.$queryRaw`',
      'new NotFoundException(',
      'tx.$queryRaw`',
      'new NotFoundException(',
      'new NotFoundException(',
      'turmaIdDaRota.toLowerCase(',
      'new NotFoundException(',
      'new UnprocessableEntityException(',
      'tx.$queryRaw`',
      'this.relogio.agora(',
      'decidirTempoDoPortao(',
      'new UnprocessableEntityException(',
    ]);
    // Nenhuma função é CRIADA no corpo: callback não tem onde nascer.
    expect(/=>|\bfunction\b/.exec(estrutura)?.[0] ?? null).toBeNull();

    // O SQL é o revisado, byte a byte (espaço normalizado). Nenhum dos três lê
    // relógio; mudar um deles derruba o teste e pede nova revisão.
    expect(sqlDoCorpo(codigo, estrutura)).toEqual([
      "SELECT t.id FROM turmas t WHERE t.id = ( SELECT o.origem_turma_id FROM ocupacoes_quadra o WHERE o.id = $::uuid AND o.company_id = $::uuid AND o.origem_tipo = 'TURMA' ) FOR UPDATE",
      'SELECT o.origem_turma_id AS "origemTurmaId", o.data AS "data", o.hora_inicio AS "horaInicio", o.status_pagamento AS "statusPagamento", t.professor_id AS "professorId" FROM ocupacoes_quadra o JOIN turmas t ON t.id = o.origem_turma_id WHERE o.id = $::uuid AND o.company_id = $::uuid AND o.origem_tipo = \'TURMA\'',
      'SELECT c.origem AS "origem", c.origem_inicial AS "origemInicial", c.completude AS "completude", c.fechada_automaticamente_em AS "fechadaAutomaticamenteEm" FROM chamadas c WHERE c.ocupacao_id = $::uuid',
    ]);

    // Os nomes da lista são os que se pensa: as exceções vêm do Nest, e a
    // decisão de tempo vem do módulo provado — não de um homônimo local.
    const fonte = readFileSync(servico, 'utf8');
    expect(fonte).toMatch(
      /import \{[^}]*\bNotFoundException\b[^}]*\bUnprocessableEntityException\b[^}]*\} from '@nestjs\/common'/,
    );
    expect(fonte).toMatch(
      /import \{[^}]*\bdecidirTempoDoPortao\b[^}]*\} from '\.\/tempo-do-portao'/,
    );
    expect(
      fonte.match(/\b(function|const|let|var|class)\s+decidirTempoDoPortao\b/g),
    ).toBeNull();
    expect(fonte).toMatch(/private readonly relogio: RelogioDaPresenca/);
  });
});

const SRC_CLASSES = join(__dirname, '..', '..', 'src', 'classes');

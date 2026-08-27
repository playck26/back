import { Prisma } from '@prisma/client';
import { CourtsService } from '../courts/courts.service';
import { HorarioFuncionamentoService } from '../courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../courts/imagem-da-quadra.service';
import type { StudentsService } from '../people/students.service';
import type { PrismaService } from '../prisma/prisma.service';
import { parseTimeOnly } from '../courts/date-time.util';
import { ClassesService } from './classes.service';
import type { EncontroDaTurma } from './encontros';

/**
 * DEF-013 — **a transação de turma estoura o timeout do Prisma quando a
 * turma tem mais de um encontro.**
 *
 * ## O que aconteceu em produção
 *
 * Deployment `90d05d88` (commit `45a4c88`, SPEC-019) subiu `ACTIVE` às
 * 02:51Z de 2026-08-27. Às 02:57 e 02:59 o log de execução registrou dois
 * 500:
 *
 * ```
 * Invalid `prisma.ocupacaoQuadra.findFirst()` invocation:
 * Transaction API error: Transaction already closed: ... The timeout for
 * this transaction was 5000 ms, however 5131 ms passed since the start of
 * the transaction.
 * code: 'P2028'  meta: { modelName: 'OcupacaoQuadra' }
 * ```
 *
 * ## Por que a SPEC-019 causou isso
 *
 * `registerClassOccupancy` percorre as ocorrências em **dois laços
 * sequenciais**, e cada volta é uma ida ao banco:
 * `horarioFuncionamento.findMany` (via `resolverParaData`) e
 * `ocupacaoQuadra.findFirst`. A janela é de 8 semanas.
 *
 * Antes da SPEC-019 a turma tinha **um** horário: 8 ocorrências, ~18 idas
 * dentro da transação. Cabia nos 5000 ms padrão do Prisma, e por isso rodou
 * meses sem ninguém ver. A SPEC-019 trocou `dia_semana` por `encontros[]` e
 * `ocorrenciasDosEncontros` passou a achatar **8 × N** ocorrências — o custo
 * da transação virou função de N. Com dois encontros, ~34 idas: atravessa os
 * 5000 ms e o Postgres derruba a transação no meio do segundo laço.
 *
 * **Não é lentidão do banco; é custo que cresce com o dado.** Aumentar o
 * `timeout` só move a parede para N maior.
 *
 * ## Por que a suíte não pegou
 *
 * Os dois testes que cobrem este caminho mockam justamente a fronteira onde
 * o custo mora: `classes.service.spec.ts` injeta um `courtsService` dublê
 * (`registerClassOccupancy: jest.fn()`), e `courts.service.spec.ts` injeta
 * um `horarios` dublê com `resolverParaData` já resolvido. Cada um prova a
 * sua metade e nenhum vê o laço atravessando a rede.
 *
 * Por isso **este arquivo monta os três de verdade** — `ClassesService`,
 * `CourtsService` e `HorarioFuncionamentoService` — e dubla só o que é mesmo
 * remoto: o cliente de transação. O que se conta é o que cruzaria a rede.
 */

/**
 * O padrão do Prisma para `$transaction` interativa, e o número que aparece
 * na mensagem de produção. Nenhum `$transaction` de turma passa `timeout`
 * (ver `classes.service.ts`), então é este que vale.
 */
const TIMEOUT_PADRAO_DO_PRISMA_MS = 5_000;

/**
 * **Parâmetro declarado, não medido.** Não dá para medir o Neon a partir do
 * teste, e fingir precisão aqui seria pior que assumir a escolha.
 *
 * 200 ms por ida é uma latência plausível para Postgres serverless visto de
 * outro provedor, e a produção é consistente com esta ordem de grandeza
 * (5131 ms atravessados numa transação de ~34 idas dá ~150 ms por ida).
 *
 * O valor foi escolhido para deixar a prova **honesta nas duas pontas**: com
 * ele, um encontro — o comportamento anterior à SPEC-019, que rodou em
 * produção sem estourar — cabe folgado, e dois encontros não cabem. Um
 * número que reprovasse os dois casos não estaria provando a regressão,
 * estaria provando que o teto é baixo.
 */
const LATENCIA_POR_IDA_MS = 200;

const UM_ENCONTRO: EncontroDaTurma[] = [
  { diaSemana: 2, horaInicio: '18:00', horaFim: '19:00' },
];

// O pedido do Israel, com as palavras dele: terça 18h e sábado 07h.
const DOIS_ENCONTROS: EncontroDaTurma[] = [
  { diaSemana: 2, horaInicio: '18:00', horaFim: '19:00' },
  { diaSemana: 6, horaInicio: '07:00', horaFim: '08:00' },
];

interface TxContado {
  tx: Prisma.TransactionClient;
  idas: string[];
  decorridoMs: () => number;
}

/**
 * Cliente de transação com **relógio virtual**: cada consulta custa
 * `latenciaMs` e, passado o teto, a seguinte é recusada com o mesmo `P2028`
 * que produção registrou.
 *
 * O relógio é virtual de propósito. Um `setTimeout` real faria o teste levar
 * cinco segundos para provar o que a aritmética já decide, e o resultado
 * passaria a depender da máquina que roda o CI.
 */
function buildTxContado(
  opcoes: { latenciaMs?: number; timeoutMs?: number } = {},
): TxContado {
  const latenciaMs = opcoes.latenciaMs ?? 0;
  const timeoutMs = opcoes.timeoutMs ?? Number.POSITIVE_INFINITY;
  const idas: string[] = [];
  let relogioMs = 0;

  function ida<T>(rotulo: string, modelo: string, valor: T): Promise<T> {
    relogioMs += latenciaMs;
    idas.push(rotulo);
    if (relogioMs > timeoutMs) {
      return Promise.reject(
        new Prisma.PrismaClientKnownRequestError(
          `Invalid \`prisma.${rotulo}()\` invocation:\n\n` +
            `Transaction API error: Transaction already closed: A query cannot ` +
            `be executed on an expired transaction. The timeout for this ` +
            `transaction was ${timeoutMs} ms, however ${relogioMs} ms passed ` +
            `since the start of the transaction.`,
          {
            code: 'P2028',
            clientVersion: '6.19.3',
            meta: { modelName: modelo },
          },
        ),
      );
    }
    return Promise.resolve(valor);
  }

  /**
   * Uma linha de horário por dia pedido, sempre aberta 06:00–22:00. Responde
   * tanto ao `diaSemana: number` de hoje quanto a um
   * `diaSemana: { in: [...] }` — o conserto provavelmente vai buscar os dias
   * de uma vez, e o dublê não pode ser o motivo de ele não passar.
   */
  function linhasDeHorario(args: {
    where?: { diaSemana?: number | { in?: number[] } };
  }) {
    const pedido = args?.where?.diaSemana;
    const dias =
      typeof pedido === 'number'
        ? [pedido]
        : Array.isArray(pedido?.in)
          ? pedido.in
          : [0, 1, 2, 3, 4, 5, 6];
    return dias.map((diaSemana) => ({
      quadraId: null,
      diaSemana,
      fechado: false,
      horaInicio: parseTimeOnly('06:00'),
      horaFim: parseTimeOnly('22:00'),
    }));
  }

  const turma = {
    id: 't1',
    companyId: 'c1',
    nome: 'Turma da manhã',
    nivelId: null,
    professorId: null,
    quadraId: 'q1',
    capacidade: 10,
    status: 'ativa',
    encontros: [] as { diaSemana: number; horaInicio: Date; horaFim: Date }[],
  };

  const tx = {
    turma: {
      create: jest.fn(() => ida('turma.create', 'Turma', turma)),
      update: jest.fn(() => ida('turma.update', 'Turma', turma)),
    },
    turmaEncontro: {
      findMany: jest.fn(() =>
        ida('turmaEncontro.findMany', 'TurmaEncontro', []),
      ),
      deleteMany: jest.fn(() =>
        ida('turmaEncontro.deleteMany', 'TurmaEncontro', { count: 0 }),
      ),
    },
    horarioFuncionamento: {
      findMany: jest.fn((args: { where?: { diaSemana?: number } }) =>
        ida(
          'horarioFuncionamento.findMany',
          'HorarioFuncionamento',
          linhasDeHorario(args),
        ),
      ),
    },
    ocupacaoQuadra: {
      findFirst: jest.fn(() =>
        ida('ocupacaoQuadra.findFirst', 'OcupacaoQuadra', null),
      ),
      findMany: jest.fn(() =>
        ida('ocupacaoQuadra.findMany', 'OcupacaoQuadra', []),
      ),
      count: jest.fn(() => ida('ocupacaoQuadra.count', 'OcupacaoQuadra', 0)),
      createMany: jest.fn(() =>
        ida('ocupacaoQuadra.createMany', 'OcupacaoQuadra', { count: 0 }),
      ),
      updateMany: jest.fn(() =>
        ida('ocupacaoQuadra.updateMany', 'OcupacaoQuadra', { count: 0 }),
      ),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    idas,
    decorridoMs: () => relogioMs,
  };
}

/**
 * O `prisma` de fora da transação. As conferências de escopo
 * (`assertQuadraDaEmpresa` e irmãs) acontecem **antes** do `$transaction` e
 * por isso não entram no orçamento — o que se conta aqui é só o que roda com
 * a transação aberta.
 */
function buildPrismaForaDaTransacao(tx: Prisma.TransactionClient) {
  return {
    quadra: {
      findFirst: jest.fn().mockResolvedValue({ id: 'q1', companyId: 'c1' }),
    },
    nivel: {
      findFirst: jest.fn().mockResolvedValue({ id: 'n1', companyId: 'c1' }),
    },
    professor: {
      findFirst: jest.fn().mockResolvedValue({ id: 'p1', companyId: 'c1' }),
    },
    turma: {
      // Serve aos dois `findFirst` de `update`: o de existência, no começo,
      // e o do `findOne` que monta a resposta no fim. Os dois rodam **fora**
      // da transação, então não entram no orçamento.
      findFirst: jest.fn().mockResolvedValue({
        id: 't1',
        companyId: 'c1',
        nome: 'Turma da manhã',
        nivelId: null,
        professorId: null,
        quadraId: 'q1',
        capacidade: 10,
        status: 'ativa',
        encontros: [],
        alunos: [],
        _count: { alunos: 0 },
      }),
    },
    turmaEncontro: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (t: Prisma.TransactionClient) => unknown) =>
      cb(tx),
    ),
  } as unknown as PrismaService;
}

function buildClassesService(tx: Prisma.TransactionClient) {
  const prisma = buildPrismaForaDaTransacao(tx);
  // Reais de propósito: é dentro deles que o laço mora.
  const horarios = new HorarioFuncionamentoService(prisma);
  const courts = new CourtsService(
    prisma,
    { exigirVinculoAprovado: jest.fn() } as unknown as StudentsService,
    horarios,
    {
      resolver: jest.fn(() => ({ imagemUrl: null })),
    } as unknown as ImagemDaQuadraService,
  );
  return new ClassesService(prisma, courts, {
    exigirVinculoAprovado: jest.fn(),
  } as unknown as StudentsService);
}

const DTO_BASE = {
  nome: 'Turma da manhã',
  quadraId: 'q1',
  capacidade: 10,
};

describe('DEF-013 — orçamento da transação de turma', () => {
  describe('o custo não pode crescer com o número de encontros', () => {
    /**
     * O teto admite **uma** consulta de horário por dia da semana distinto —
     * seja porque o conserto memoiza (`resolverParaData` só depende de
     * `data.getUTCDay()`), seja porque busca os dias de uma vez. O que ele
     * recusa é uma consulta por **ocorrência**, que é o que existe hoje.
     *
     * Fixas na criação: `turma.create`, a consulta de conflito e o
     * `createMany`.
     */
    function tetoDaCriacao(encontros: EncontroDaTurma[]) {
      const diasDistintos = new Set(encontros.map((e) => e.diaSemana)).size;
      return 3 + diasDistintos;
    }

    it('criar turma de 1 encontro cabe no teto', async () => {
      const { tx, idas } = buildTxContado();
      const service = buildClassesService(tx);

      await service.create('c1', { ...DTO_BASE, encontros: UM_ENCONTRO });

      expect(idas.length).toBeLessThanOrEqual(tetoDaCriacao(UM_ENCONTRO));
    });

    it('criar turma de 2 encontros cabe no teto', async () => {
      const { tx, idas } = buildTxContado();
      const service = buildClassesService(tx);

      await service.create('c1', { ...DTO_BASE, encontros: DOIS_ENCONTROS });

      expect(idas.length).toBeLessThanOrEqual(tetoDaCriacao(DOIS_ENCONTROS));
    });

    /**
     * A edição custa mais que a criação — ela ainda cancela as ocupações
     * futuras antes de regerar — e é o caminho que o gestor usa mais, porque
     * turma se cria uma vez e se ajusta várias.
     */
    it('editar a recorrência para 2 encontros cabe no teto', async () => {
      const { tx, idas } = buildTxContado();
      const service = buildClassesService(tx);

      await service.update('c1', 't1', { encontros: DOIS_ENCONTROS });

      const diasDistintos = new Set(DOIS_ENCONTROS.map((e) => e.diaSemana))
        .size;
      // Fixas: `turma.update`, o `updateMany` do cancelamento, a consulta de
      // conflito e o `createMany`.
      expect(idas.length).toBeLessThanOrEqual(4 + diasDistintos);
    });
  });

  describe('o sintoma que produção registrou (P2028)', () => {
    /**
     * O controle. Com um encontro o custo cabe nos 5000 ms — é o que rodou
     * em produção desde a SPEC-010 sem estourar. Se este teste falhar junto
     * com o próximo, quem está errada é a latência declarada, não o código.
     */
    it('1 encontro atravessa a transação sem estourar o timeout', async () => {
      const { tx, decorridoMs } = buildTxContado({
        latenciaMs: LATENCIA_POR_IDA_MS,
        timeoutMs: TIMEOUT_PADRAO_DO_PRISMA_MS,
      });
      const service = buildClassesService(tx);

      await expect(
        service.create('c1', { ...DTO_BASE, encontros: UM_ENCONTRO }),
      ).resolves.toBeDefined();
      expect(decorridoMs()).toBeLessThan(TIMEOUT_PADRAO_DO_PRISMA_MS);
    });

    it('2 encontros também precisam atravessar — hoje morrem em P2028', async () => {
      const { tx } = buildTxContado({
        latenciaMs: LATENCIA_POR_IDA_MS,
        timeoutMs: TIMEOUT_PADRAO_DO_PRISMA_MS,
      });
      const service = buildClassesService(tx);

      await expect(
        service.create('c1', { ...DTO_BASE, encontros: DOIS_ENCONTROS }),
      ).resolves.toBeDefined();
    });

    /**
     * **A segunda cara do mesmo defeito, e ela é pior que um 500.**
     *
     * O `try/catch` de `registerClassOccupancy` existe para traduzir a
     * violação da constraint `EXCLUDE` em 409. Ele captura
     * `PrismaClientKnownRequestError` inteiro — então um `P2028` que caia
     * durante o `createMany` sai como "conflito de horário com ocupação
     * existente" numa quadra vazia. Um 500 manda investigar; um 409
     * mentiroso manda desistir.
     *
     * Aqui a transação é apertada até o relógio virar **no `createMany`**,
     * com folga para os dois laços — o que isola essa tradução errada do
     * estouro que já vive no teste acima.
     */
    it('timeout no createMany não pode virar 409 de conflito', async () => {
      const { tx, idas } = buildTxContado();
      const service = buildClassesService(tx);
      // Uma passagem seca só para descobrir quantas idas o caminho custa
      // hoje; o teto abaixo é derivado dela, não chutado.
      await service.create('c1', { ...DTO_BASE, encontros: UM_ENCONTRO });
      const idasDoCaminho = idas.length;

      const apertado = buildTxContado({
        latenciaMs: LATENCIA_POR_IDA_MS,
        // Estoura exatamente na última ida, que é o `createMany`.
        timeoutMs: (idasDoCaminho - 1) * LATENCIA_POR_IDA_MS,
      });
      const outro = buildClassesService(apertado.tx);

      await expect(
        outro.create('c1', { ...DTO_BASE, encontros: UM_ENCONTRO }),
      ).rejects.toMatchObject({ code: 'P2028' });
    });
  });
});

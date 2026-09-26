import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { PresencaService } from './presenca.service';
import type { CorteDaPresenca } from '../presenca-automatica/corte-da-presenca';
import type { RelogioDaPresenca } from './relogio-da-presenca';

// TEST (SPEC-014): unit tests de `presencas` com Prisma mockado.
//
// ATENÇÃO ao ler estes testes: mock **não tem constraint**. INV-015 (par
// único) e a metade de INV-016 que proíbe presença em reserva avulsa são
// impostas pelo banco (UNIQUE, CHECK e FK composta) e provadas por
// violação no dry-run da migration, não aqui. O que se prova aqui é a
// lógica que o banco não pode expressar: janela de datas, versão, escopo
// do professor e composição da chamada.

interface TxMock {
  presenca: { findMany: jest.Mock; upsert: jest.Mock; count: jest.Mock };
  chamada: { findUnique: jest.Mock; upsert: jest.Mock };
  // SPEC-031/AC-019: a chamada passou a marcar quem avisou falta.
  faltaAvisada: { findMany: jest.Mock };
  reposicaoDeAula: { findMany: jest.Mock };
  turmaAluno: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
}

// SPEC-015/AC-000i — o portão da chamada **não** usa mais
// `prisma.ocupacaoQuadra.findFirst`. Ele faz dois statements dentro da
// transação: (0a) descobre e trava a linha da turma, (0b) relê ocorrência e
// dono já com o lock na mão. Os dois passam por `$queryRaw`, e o mock
// abaixo é o que eles enxergam.
//
// **Mock nenhum prova concorrência** — a garantia de que 0b enxerga o
// commit alheio é do Postgres, e está provada em
// `harness/chamada-e2e/bloq9-snapshot.ts` e `matriz-raiz.ts`, contra banco
// real e duas conexões. O que se prova aqui é a lógica: quem é recusado,
// com que código, e em que ordem.
interface EstadoDaOcorrencia {
  ocupacao: Record<string, unknown> | null;
  professorIdDaTurma: string | null;
}

/**
 * SPEC-057/TASK-001/D5 — o portão passou a reler o CABEÇALHO sob o lock (a
 * origem inicial decide qual relógio guarda a janela). Este dublê responde
 * "sem cabeçalho" a essa releitura e não a conta na alternância 0a/0b.
 */
function ehReleituraDoCabecalho(sql: unknown): boolean {
  return Array.isArray(sql) && sql.join('?').includes('FROM chamadas c');
}

function buildMocks() {
  const estado: EstadoDaOcorrencia = {
    ocupacao: ocupacao(),
    professorIdDaTurma: 'p1',
  };
  // Ímpar = 0a (o lock), par = 0b (a releitura). Alterna em vez de contar
  // uma vez só, para que um teste que passe pelo portão duas vezes não
  // caia num estado impossível.
  let statement = 0;
  const tx: TxMock = {
    // SPEC-076 — o portão agora é exercitado pelo `registrarNaoHouve`, que
    // conta as presenças antes de gravar o cabeçalho.
    presenca: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    faltaAvisada: { findMany: jest.fn().mockResolvedValue([]) },
    // SPEC-046 — o duble precisa TER o delegate: a chamada passou a
    // carregar quem vem repor, e sem esta linha 32 casos morrem com
    // `Cannot read properties of undefined`. **Setima vez neste trabalho
    // que uma fixture mentiu sobre o cliente real.**
    reposicaoDeAula: { findMany: jest.fn().mockResolvedValue([]) },
    chamada: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest
        .fn()
        .mockResolvedValue({ ocupacaoId: 'oc1', completude: 'nao_houve' }),
    },
    turmaAluno: { findMany: jest.fn() },
    $queryRaw: jest.fn((sql: unknown) => {
      if (ehReleituraDoCabecalho(sql)) return Promise.resolve([]);
      statement += 1;
      const oc = estado.ocupacao;
      if (!oc) return Promise.resolve([]);
      if (statement % 2 === 1) {
        return Promise.resolve([{ id: oc.origemTurmaId }]);
      }
      return Promise.resolve([
        {
          origemTurmaId: oc.origemTurmaId,
          data: oc.data,
          // SPEC-027: a releitura sob o lock passou a trazer `hora_inicio`,
          // porque o portão da chamada olha a hora. O mock precisa espelhar
          // a query — mock que devolve menos colunas que o SQL real produz
          // `undefined` silencioso, e o teste passa a medir outra coisa.
          horaInicio: oc.horaInicio,
          statusPagamento: oc.statusPagamento,
          professorId: estado.professorIdDaTurma,
        },
      ]);
    }),
  };
  const prisma = {
    professor: { findFirst: jest.fn() },
    turma: { findFirst: jest.fn() },
    ocupacaoQuadra: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
    },
    turmaAluno: { findMany: jest.fn() },
    presenca: { findMany: jest.fn().mockResolvedValue([]) },
    chamada: { findUnique: jest.fn().mockResolvedValue(null) },
    faltaAvisada: { findMany: jest.fn().mockResolvedValue([]) },
    // SPEC-046 — o duble precisa TER o delegate: a chamada passou a
    // carregar quem vem repor, e sem esta linha 32 casos morrem com
    // `Cannot read properties of undefined`. **Setima vez neste trabalho
    // que uma fixture mentiu sobre o cliente real.**
    reposicaoDeAula: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  // SPEC-076/D1 — o `estado` do GET relê a ocorrência: a mesma que o teste
  // armou em `findFirst`, sem cabeçalho. O estado em si é provado no db-spec
  // (`spec-076-estado`), pelo resolvedor real.
  prisma.ocupacaoQuadra.findFirstOrThrow.mockImplementation(
    async (...args: unknown[]) => ({
      chamadas: [],
      ...((await prisma.ocupacaoQuadra.findFirst(...args)) as object),
    }),
  );
  // A matrícula lida DENTRO da transação é a mesma que o teste arma em
  // `prisma.turmaAluno.findMany` — delegar evita ter de armar duas vezes.
  tx.turmaAluno.findMany = jest.fn(
    (...args: unknown[]): unknown =>
      prisma.turmaAluno.findMany(...args) as unknown,
  );
  return { prisma: prisma as unknown as PrismaService, tx, estado };
}

/**
 * Arma a ocorrência para os DOIS caminhos: o `GET` (`chamada`), que ainda
 * usa `ocupacaoQuadra.findFirst`, e o `PUT`, que passou a ler por
 * `$queryRaw` sob o lock. `null` = não existe, ou não é deste professor.
 */
function armarOcupacao(
  prisma: PrismaService,
  estado: EstadoDaOcorrencia,
  oc: Record<string, unknown> | null,
) {
  (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(oc);
  estado.ocupacao = oc;
}

/**
 * **DEF-020 — e este helper era uma bomba-relógio.**
 *
 * Ele montava "hoje" com `Date.UTC(...getUTCDate())`, e o serviço passou a
 * usar `hojeNoFusoDoClube()`. Das 21h à meia-noite em Brasília os dois
 * discordam do dia, e a suíte inteira passava a acusar `AULA_FUTURA`.
 *
 * O detalhe que assusta: **passou às 20h54 e falhou às 21h45.** Não mudou uma
 * linha entre as duas rodadas — mudou o relógio. Um teste que depende da hora
 * em que roda não é verde nem vermelho, é sorteio, e teria falhado no CI
 * dependendo só do horário do push.
 *
 * A regra vale nas três camadas, e a correção precisou das três: produto,
 * fixture de banco (`test/banco/hoje-no-clube-sql.ts`) e aqui. **Uma
 * convenção, não duas** — o que o próprio comentário da SPEC-014 já dizia.
 */
function diaRelativo(dias: number): Date {
  const base = hojeNoFusoDoClube().getTime();
  return new Date(base + dias * 24 * 60 * 60 * 1000);
}

function ocupacao(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oc1',
    origemTurmaId: 't1',
    origemTipo: 'TURMA',
    statusPagamento: 'pendente_pagamento',
    data: diaRelativo(0),
    /**
     * SPEC-027 — **00:00 às 23:59, e o horário é escolhido para NÃO depender
     * do relógio.**
     *
     * A janela da chamada passou a olhar a hora: a aula das 18h de hoje não
     * aceita chamada às 8h da manhã. Com a fixture em 09:00, esta suíte
     * passaria depois das 9h e falharia antes — o mesmo sorteio que o DEF-020
     * acabou de custar 12 provas.
     *
     * `00:00` já começou em qualquer instante do dia (`0 <= minutos`, sempre),
     * e `23:59` só termina no último minuto — então "hoje" é sempre uma aula
     * **em andamento**, que é o estado que estes testes querem exercitar.
     * Quem quiser testar a fronteira usa `ocupacao({ horaInicio: ... })`.
     */
    horaInicio: new Date('1970-01-01T00:00:00.000Z'),
    horaFim: new Date('1970-01-01T23:59:00.000Z'),
    ...overrides,
  };
}

/** SPEC-057/TASK-001/D4 — ambiente que nunca ativou a presença automática. */
const semCorte = {
  ler: () => Promise.resolve(null),
} as unknown as CorteDaPresenca;

/**
 * SPEC-076/D11 — o portão lê `agora` do `RelogioDaPresenca`, e não mais do
 * `$queryRaw` da transação. Aqui ele é o relógio do processo, que respeita o
 * `setSystemTime` dos testes de horário.
 */
const relogioDoProcesso = {
  agora: () => Promise.resolve(new Date()),
} as unknown as RelogioDaPresenca;

describe('PresencaService (SPEC-014)', () => {
  let prisma: PrismaService;
  let estado: EstadoDaOcorrencia;
  let service: PresencaService;

  beforeEach(() => {
    const b = buildMocks();
    prisma = b.prisma;
    estado = b.estado;
    service = new PresencaService(prisma, semCorte, relogioDoProcesso);
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    // O `GET` monta a lista com o nome do aluno; o `PUT` só usa `alunoId`.
    // Um mock só serve os dois, e é o que permite os testes irem por
    // `GET -> PUT` em vez de fixar a versão na mão.
    (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
      { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno 1' } } },
      { alunoId: 'a2', aluno: { usuario: { nome: 'Aluno 2' } } },
    ]);
  });

  // SPEC-027 — os testes de horário fixam o relógio (`setSystemTime`). Sem
  // devolvê-lo, o relógio falso vaza para o resto do arquivo e o próximo
  // teste passa a medir uma data congelada — falha que aparece longe da
  // causa.
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * SPEC-076/D7 — **o portão é exercitado pelo `nao_houve`.** O `PUT` da
   * chamada saiu (D1); o portão (`travarEValidarOcorrencia`) continua, e é o
   * mesmo para registrar e para desfazer "a aula não aconteceu". Os testes de
   * janela, cancelamento e escopo, que passavam pelo `PUT`, passam por aqui.
   */
  const naoHouve = () => service.registrarNaoHouve('c1', 'oc1', 'u1', true);

  describe('INV-018 — quem escreve', () => {
    it('recusa usuário com papel de professor mas sem ficha na empresa', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(naoHouve()).rejects.toBeInstanceOf(ForbiddenException);
    });

    // O `professorId` entra no WHERE. Ocorrência de colega devolve 404, não
    // 403 — 403 confirmaria que ela existe, e o professor mapearia a grade
    // dos colegas por tentativa e erro.
    it('ocorrência de turma de colega devolve 404 — no portão', async () => {
      armarOcupacao(prisma, estado, ocupacao());
      estado.professorIdDaTurma = 'colega';

      await expect(naoHouve()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ocorrência de turma de colega devolve 404 — na leitura', async () => {
      armarOcupacao(prisma, estado, null);

      await expect(service.chamada('c1', 'u1', 'oc1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.ocupacaoQuadra.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            origemTurma: { professorId: 'p1' },
          }),
        }),
      );
    });
  });

  describe('INV-017 — a janela', () => {
    /**
     * SPEC-027 — **a aula de HOJE que ainda não começou também é futura.**
     *
     * O pedido do Israel: *"só pode realizar a chamada durante ou depois da
     * aula"*. Antes, o portão era `data > hoje`, então a aula das 18h de hoje
     * aceitava chamada às 8h da manhã — mesmo dia, comparação satisfeita.
     *
     * ---
     *
     * **O relógio é FIXADO, e a primeira versão desta prova não fixava.**
     *
     * Ela usava `23:58` e um comentário meu dizendo que o horário garantia
     * "ainda não começou em qualquer instante em que a suíte rode, menos os
     * dois últimos minutos do dia". A validação cruzada respondeu o óbvio:
     * **"menos dois minutos por dia" é exatamente o problema.** Rodando entre
     * 23:58 e 00:00 no fuso do clube, a aula já teria começado e a prova
     * falharia sem nada estar errado no produto.
     *
     * Foi a lição do DEF-020 me pegando dentro da correção que a citava. Uma
     * prova de regra de tempo **não pode depender do relógio de quem a roda** —
     * e "quase nunca depende" continua sendo depender.
     *
     * `setSystemTime` fixa 14:00 em São Paulo (17:00Z). A partir daí, 18:00
     * ainda não começou e 09:00 já começou, todo dia, para sempre.
     */
    const AS_14H_EM_SAO_PAULO = new Date('2026-09-15T17:00:00.000Z');

    it('recusa a aula de HOJE que ainda não começou', async () => {
      jest.useFakeTimers().setSystemTime(AS_14H_EM_SAO_PAULO);
      armarOcupacao(
        prisma,
        estado,
        ocupacao({
          data: diaRelativo(0),
          horaInicio: new Date('1970-01-01T18:00:00.000Z'),
          horaFim: new Date('1970-01-01T19:00:00.000Z'),
        }),
      );

      await expect(naoHouve()).rejects.toMatchObject({
        response: { code: 'AULA_FUTURA' },
      });
    });

    it('e ACEITA a aula de hoje que já começou — o outro lado', async () => {
      // Sem esta, um portão que recusasse TUDO passaria na de cima, e o
      // professor ficaria sem lançar chamada nenhuma.
      jest.useFakeTimers().setSystemTime(AS_14H_EM_SAO_PAULO);
      armarOcupacao(
        prisma,
        estado,
        ocupacao({
          data: diaRelativo(0),
          horaInicio: new Date('1970-01-01T09:00:00.000Z'),
          horaFim: new Date('1970-01-01T10:00:00.000Z'),
        }),
      );

      await expect(naoHouve()).resolves.toMatchObject({
        completude: 'nao_houve',
      });
    });

    it('a aula em andamento (começou, não terminou) é aceita', async () => {
      // A fronteira do meio, que só existe com o relógio fixado: às 14h, uma
      // aula de 13h às 15h está acontecendo.
      jest.useFakeTimers().setSystemTime(AS_14H_EM_SAO_PAULO);
      armarOcupacao(
        prisma,
        estado,
        ocupacao({
          data: diaRelativo(0),
          horaInicio: new Date('1970-01-01T13:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
        }),
      );

      await expect(naoHouve()).resolves.toMatchObject({
        completude: 'nao_houve',
      });
    });

    it('recusa aula futura (o toque na linha errada da grade)', async () => {
      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(1) }));

      await expect(naoHouve()).rejects.toMatchObject({
        response: { code: 'AULA_FUTURA' },
      });
    });

    it('aceita a aula de hoje', async () => {
      armarOcupacao(prisma, estado, ocupacao());

      await expect(naoHouve()).resolves.toMatchObject({
        completude: 'nao_houve',
      });
    });

    it('aceita aula de 7 dias atrás e recusa a de 8', async () => {
      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(-7) }));
      await expect(naoHouve()).resolves.toMatchObject({
        completude: 'nao_houve',
      });

      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(-8) }));
      await expect(naoHouve()).rejects.toMatchObject({
        response: { code: 'AULA_ANTIGA' },
      });
    });
  });

  describe('INV-016 — a metade que é regra de escrita', () => {
    it('recusa chamada em aula cancelada', async () => {
      armarOcupacao(prisma, estado, ocupacao({ statusPagamento: 'cancelado' }));

      await expect(naoHouve()).rejects.toMatchObject({
        response: { code: 'AULA_CANCELADA' },
      });
    });
  });

  describe('INV-020 — a chamada salva é o retrato da turma', () => {
    beforeEach(() => {
      armarOcupacao(prisma, estado, ocupacao());
    });

    // O caso que a validação cruzada expôs: aula na terça, aluno novo entra
    // na quarta, professor lança a chamada na quinta. Sem esta regra, o
    // aluno novo apareceria como se estivesse lá na terça.
    //
    // SPEC-015: o que decide não é mais "existe presença", e sim **o
    // cabeçalho declarar completude**. Sem essa distinção, o mesmo par de
    // linhas servia para "completa de uma turma de 2" e "pela metade de uma
    // turma de 10" — era a DEF-002.
    it('chamada COMPLETA ignora quem entrou na turma depois', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Aluno Um' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno Um' } } },
        { alunoId: 'a9', aluno: { usuario: { nome: 'Entrou Depois' } } },
      ]);
      (prisma.chamada.findUnique as jest.Mock).mockResolvedValue({
        completude: 'completa',
        esperados: 1,
        updatedAt: new Date(1_700_000_000_000),
      });

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos.map((a) => a.alunoId)).toEqual(['a1']);
      expect(res.completude).toBe('completa');
      // AC-000g: a versão passa a incluir o cabeçalho.
      expect(res.versao).toBe('1:1700000000000#1700000000000');
    });

    // O outro lado da mesma moeda: sem cabeçalho (ou com ele declarando
    // `desconhecida`), a chamada pode estar pela metade — e aí esconder
    // quem falta é o defeito, não a proteção. Devolve a união, para o
    // professor conseguir fechar o que ficou aberto.
    it('chamada de completude DESCONHECIDA devolve a união, para dar conserto', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Aluno Um' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno Um' } } },
        { alunoId: 'a2', aluno: { usuario: { nome: 'Nunca Marcado' } } },
      ]);
      (prisma.chamada.findUnique as jest.Mock).mockResolvedValue({
        completude: 'desconhecida',
        esperados: null,
        updatedAt: new Date(1_700_000_000_000),
      });

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos.map((a) => a.alunoId).sort()).toEqual(['a1', 'a2']);
      expect(res.alunos.find((a) => a.alunoId === 'a2')?.status).toBeNull();
      expect(res.completude).toBe('desconhecida');
    });

    // A janela entre este deploy e o `contract`: instância antiga pode ter
    // gravado presença sem cabeçalho. Trata como legado, que é o que o
    // backfill vai registrar depois.
    it('presença sem cabeçalho é tratada como legado, não como completa', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Aluno Um' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno Um' } } },
        { alunoId: 'a2', aluno: { usuario: { nome: 'Ficou de Fora' } } },
      ]);
      (prisma.chamada.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.completude).toBe('desconhecida');
      expect(res.alunos).toHaveLength(2);
    });

    // AC-010 — removido depois da chamada não some do histórico, mas fica
    // sinalizado.
    it('mantém quem saiu da turma, marcado como fora dela', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Saiu Depois' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([]);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos[0]).toMatchObject({ naTurmaHoje: false });
    });

    it('chamada ainda não salva lista a turma atual', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a2', aluno: { usuario: { nome: 'Zeca' } } },
        { alunoId: 'a1', aluno: { usuario: { nome: 'Ana' } } },
      ]);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos.map((a) => a.nome)).toEqual(['Ana', 'Zeca']);
      // AC-000j: opaca. O que se afirma é "nada gravado ainda", e isso se
      // lê pelo status nulo de todo mundo, logo abaixo — não pelo formato.
      expect(typeof res.versao).toBe('string');
      expect(res.alunos.every((a) => a.status === null)).toBe(true);
    });
  });
  // SPEC-076/D7 — os blocos "AC-006 — só aluno alocado", "INV-019 — versão
  // otimista" e "INV-026/INV-027 — chamada completa e o cabeçalho" saíram:
  // provavam a gravação da chamada pelo `PUT`, que não existe mais (D1). O
  // que os substitui é a AC-001 (a rota dá 404 e nada muda) e a AC-002 (o
  // banco recusa presença com autor humano) — ver o `CLI_AUDIT.md`.
});

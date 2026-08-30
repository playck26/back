import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { PresencaService } from './presenca.service';

/**
 * TEST (SPEC-030:TASK-005) — `registrarNaoHouve`, o método central da spec.
 *
 * **Este arquivo existia como buraco declarado no prompt de validação
 * cruzada.** O método foi escrito, o CI ficou verde com 812 provas, e
 * nenhuma delas o exercitava: o verde dizia que nada mais quebrou, não que
 * isto funciona.
 *
 * ATENÇÃO ao ler: **mock não tem constraint.** O CHECK
 * `chamadas_completude_esperados_check` — que recusa `nao_houve` com
 * `esperados` não nulo — é do banco, e aqui só se prova que o serviço
 * **manda** `esperados: null`. A prova contra Postgres real é outra coisa, e
 * está em `test/banco/`.
 *
 * O que se prova aqui é a lógica que o banco não pode expressar: quem é
 * recusado, com que código, em que ordem, e o que é gravado.
 */

/** O que o `upsert` do cabeçalho recebe — tipado para o lint não ver `any`. */
interface ArgsDoUpsert {
  where: { ocupacaoId: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

interface TxMock {
  presenca: { count: jest.Mock };
  chamada: { upsert: jest.Mock<Promise<unknown>, [ArgsDoUpsert]> };
  $queryRaw: jest.Mock;
}

/** A n-ésima chamada do `upsert`, já tipada. */
function argsDoUpsert(tx: TxMock, n = 0): ArgsDoUpsert {
  return tx.chamada.upsert.mock.calls[n][0];
}

interface EstadoDaOcorrencia {
  ocupacao: Record<string, unknown> | null;
  professorIdDaTurma: string | null;
}

/**
 * "Hoje" pela MESMA convenção do serviço (`hojeNoFusoDoClube`).
 *
 * Montar com `Date.UTC(...)` seria a quarta ocorrência da família de defeitos
 * de 2026-08-30: das 21h à meia-noite os dois discordam do dia, e a suíte
 * viraria sorteio dependendo da hora do push.
 */
function diaRelativo(dias: number): Date {
  return new Date(hojeNoFusoDoClube().getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * `00:00`–`23:59` de propósito: a aula "já começou" em qualquer instante do
 * dia e "ainda não terminou" até o último minuto. Assim nenhum teste daqui
 * depende da hora em que roda — quem quer testar a fronteira passa a hora.
 */
function ocupacao(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oc1',
    origemTurmaId: 't1',
    origemTipo: 'TURMA',
    statusPagamento: 'pendente_pagamento',
    data: diaRelativo(-1),
    horaInicio: new Date('1970-01-01T00:00:00.000Z'),
    horaFim: new Date('1970-01-01T23:59:00.000Z'),
    ...overrides,
  };
}

function buildMocks() {
  const estado: EstadoDaOcorrencia = {
    ocupacao: ocupacao(),
    professorIdDaTurma: 'p1',
  };
  // Ímpar = (0a) o lock; par = (0b) a releitura sob o lock. Alterna, em vez
  // de contar uma vez, para que um teste que chame o método duas vezes não
  // caia num estado impossível.
  let statement = 0;
  const tx: TxMock = {
    presenca: { count: jest.fn().mockResolvedValue(0) },
    chamada: {
      upsert: jest.fn().mockResolvedValue({
        ocupacaoId: 'oc1',
        completude: 'nao_houve',
      }),
    },
    $queryRaw: jest.fn(() => {
      statement += 1;
      const oc = estado.ocupacao;
      // Ocupação inexistente, de outra empresa ou que não é TURMA: as três
      // caem no mesmo lugar, porque `company_id` e `origem_tipo` estão no
      // `WHERE` das duas queries.
      if (!oc) return Promise.resolve([]);
      if (statement % 2 === 1) {
        return Promise.resolve([{ id: oc.origemTurmaId }]);
      }
      return Promise.resolve([
        {
          origemTurmaId: oc.origemTurmaId,
          data: oc.data,
          horaInicio: oc.horaInicio,
          statusPagamento: oc.statusPagamento,
          professorId: estado.professorIdDaTurma,
        },
      ]);
    }),
  };
  const prisma = {
    professor: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx, estado };
}

describe('PresencaService.registrarNaoHouve (SPEC-030)', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let estado: EstadoDaOcorrencia;
  let service: PresencaService;

  beforeEach(() => {
    const b = buildMocks();
    prisma = b.prisma;
    tx = b.tx;
    estado = b.estado;
    service = new PresencaService(prisma);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------- REQ-001
  describe('o que grava (REQ-001)', () => {
    it('grava `nao_houve` com `esperados: null` e nenhuma presença', async () => {
      await service.registrarNaoHouve('c1', 'oc1', 'u-prof', true);

      const args = argsDoUpsert(tx);
      expect(args.create).toMatchObject({
        completude: 'nao_houve',
        esperados: null,
        origemTipo: 'TURMA',
        companyId: 'c1',
      });
      // `esperados: null` não é detalhe: o CHECK do banco recusa
      // `nao_houve` com valor, e quem diz que a aula não aconteceu não está
      // afirmando sobre quantos alunos eram esperados.
      expect(args.update).toMatchObject({
        completude: 'nao_houve',
        esperados: null,
      });
    });

    it('é idempotente: `upsert`, e o update reescreve os mesmos campos', async () => {
      // Repetir a ação não é engano do usuário, é rede instável — a mesma
      // razão pela qual `cancelBooking` é idempotente.
      await service.registrarNaoHouve('c1', 'oc1', 'u-prof', true);
      await service.registrarNaoHouve('c1', 'oc1', 'u-prof', true);

      expect(tx.chamada.upsert).toHaveBeenCalledTimes(2);
      expect(argsDoUpsert(tx, 1)).toMatchObject({
        where: { ocupacaoId: 'oc1' },
      });
    });
  });

  // -------------------------------------------------------------- REQ-004a
  describe('quem registrou fica gravado (REQ-004a / D1b)', () => {
    it.each([
      ['professor', 'u-prof', true],
      ['gestor', 'u-gestor', false],
    ])(
      '%s: `registradaPor` é o usuário autenticado',
      async (_papel, usuarioId, comoProfessor) => {
        await service.registrarNaoHouve('c1', 'oc1', usuarioId, comoProfessor);

        const args = argsDoUpsert(tx);
        expect(args.create.registradaPor).toBe(usuarioId);
        // Também no `update`: quem registrou por ÚLTIMO é a resposta útil
        // quando o gestor fecha a aula de um professor que saiu do clube.
        expect(args.update.registradaPor).toBe(usuarioId);
      },
    );
  });

  // --------------------------------------------------------------- REQ-004
  describe('o escopo estreita por papel, não por rota (REQ-004)', () => {
    it('professor: ocorrência de COLEGA devolve 404, não 403', async () => {
      // 403 confirmaria que a aula existe. O 404 é a mesma regra da
      // INV-023b: não entregar informação sobre o que não é seu.
      estado.professorIdDaTurma = 'outro-professor';

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });

    it('gestor: a MESMA ocorrência de outro professor da empresa PASSA', async () => {
      // **É o par da prova acima, e é o que separa "escopo de professor
      // ausente" de "escopo ausente".** Se as duas caíssem juntas numa
      // sabotagem, o gestor estaria com o escopo do professor copiado.
      estado.professorIdDaTurma = 'outro-professor';

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false),
      ).resolves.toMatchObject({ completude: 'nao_houve' });
    });

    it('ocupação de outra empresa devolve 404 para os DOIS papéis', async () => {
      // `company_id` está no `WHERE` das duas queries do portão, e não é
      // opcional em nenhum caminho: o mock devolve vazio, como o SQL real.
      estado.ocupacao = null;

      await expect(
        service.registrarNaoHouve('c-outra', 'oc1', 'u-prof', true),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.registrarNaoHouve('c-outra', 'oc1', 'u-gestor', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('INV-018 — o `professorId` vem do BANCO, e só quando há papel de professor', async () => {
      await service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false);
      expect(prisma.professor.findFirst).not.toHaveBeenCalled();

      await service.registrarNaoHouve('c1', 'oc1', 'u-prof', true);
      expect(prisma.professor.findFirst).toHaveBeenCalledWith({
        where: { usuarioId: 'u-prof', companyId: 'c1' },
        select: { id: true },
      });
    });

    it('usuário sem ficha de professor leva 403, não passa como gestor', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-qualquer', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------- REQ-003 / REQ-007 / 030d
  describe('as guardas herdadas de `salvarChamada`', () => {
    it('REQ-007 — aula CANCELADA continua recusando, com `AULA_CANCELADA`', async () => {
      // `nao_houve` não é porta dos fundos para o portão da INV-016.
      estado.ocupacao = ocupacao({ statusPagamento: 'cancelado' });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toMatchObject({ response: { code: 'AULA_CANCELADA' } });
    });

    it('REQ-003 — aula que ainda não começou leva `AULA_FUTURA`', async () => {
      // Relógio fixo: sem isso, esta prova muda de resposta conforme a hora
      // do dia em que o CI roda — foi assim que 11 provas caíram em
      // 2026-08-30, às 00:03 de São Paulo.
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
      estado.ocupacao = ocupacao({
        data: diaRelativo(0),
        horaInicio: new Date('1970-01-01T23:00:00.000Z'),
        horaFim: new Date('1970-01-01T23:59:00.000Z'),
      });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toMatchObject({ response: { code: 'AULA_FUTURA' } });
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });

    it('aula fora da janela retroativa leva `AULA_ANTIGA`', async () => {
      estado.ocupacao = ocupacao({ data: diaRelativo(-30) });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toMatchObject({ response: { code: 'AULA_ANTIGA' } });
    });

    it('LIM-030d — não sobrescreve chamada COM presença', async () => {
      // AC-012: cancelar depois não desfaz quem esteve lá. Apagar presenças
      // aqui contradiria isso, e em silêncio.
      tx.presenca.count.mockResolvedValue(3);

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toMatchObject({ response: { code: 'CHAMADA_COM_PRESENCA' } });
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });

    it('cabeçalho SEM presença (chamada legada vazia) é sobrescrito', async () => {
      // O guard é presença, não cabeçalho: uma chamada `desconhecida` que
      // nunca teve linha é exatamente o caso que esta rota resolve.
      tx.presenca.count.mockResolvedValue(0);

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).resolves.toMatchObject({ completude: 'nao_houve' });
    });
  });

  describe('a rota aninhada do gestor confere a turma da URL', () => {
    // Ressalva da validação cruzada. `PUT /classes/turma-A/presencas/
    // ocupacao-da-turma-B/nao-houve` devolvia 200 e alterava B — não escalava
    // privilégio, mas a URL mentia sobre o que estava sendo alterado.
    it('RECUSA quando a ocorrência é de outra turma da mesma empresa', async () => {
      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false, 'OUTRA'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });

    it('a conferência da URL vale para o PROFESSOR também', async () => {
      // A rota dele não é aninhada hoje, mas o portão é um só: se algum dia
      // ela for, a regra já vale — e a prova impede que alguém a passe
      // acreditando que é ignorada.
      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true, 'OUTRA'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ACEITA quando a turma da URL é a da ocorrência', async () => {
      // O par: sem ele, uma conferência que recusasse SEMPRE passaria na
      // prova acima e a rota do gestor estaria morta.
      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false, 't1'),
      ).resolves.toMatchObject({ completude: 'nao_houve' });
    });

    // **Achado 4 da 2ª validação cruzada.** A prova anterior usava só uma
    // ocorrência PASSADA e VÁLIDA, então não discriminava a ordem: qualquer
    // posição da conferência a fazia passar. Com uma ocorrência FUTURA de
    // outra turma, a conferência tardia devolvia `422 AULA_FUTURA` — contando
    // o estado de uma ocorrência que a URL não deveria alcançar.
    it('ocorrência FUTURA de outra turma: 404, e NÃO 422 AULA_FUTURA', async () => {
      estado.ocupacao = ocupacao({
        origemTurmaId: 'OUTRA',
        data: diaRelativo(3),
      });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false, 't1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ocorrência CANCELADA de outra turma: 404, e NÃO 422 AULA_CANCELADA', async () => {
      estado.ocupacao = ocupacao({
        origemTurmaId: 'OUTRA',
        statusPagamento: 'cancelado',
      });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-gestor', false, 't1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a rota do professor não passa turma, e continua funcionando', async () => {
      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).resolves.toMatchObject({ completude: 'nao_houve' });
    });
  });

  describe('a ordem das guardas', () => {
    // Ordem diferente muda QUAL erro o cliente vê, e a tela decide o texto
    // pelo código. O escopo vem primeiro de propósito: um estranho não pode
    // descobrir que a aula está cancelada.
    it('o 404 de escopo vem ANTES de `AULA_CANCELADA`', async () => {
      estado.professorIdDaTurma = 'outro-professor';
      estado.ocupacao = ocupacao({ statusPagamento: 'cancelado' });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('`AULA_CANCELADA` vem ANTES da checagem de presença', async () => {
      estado.ocupacao = ocupacao({ statusPagamento: 'cancelado' });
      tx.presenca.count.mockResolvedValue(3);

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toMatchObject({ response: { code: 'AULA_CANCELADA' } });
    });
  });

  describe('o portão roda DENTRO da transação', () => {
    it('trava a turma antes de ler, e só então grava', async () => {
      // Os dois statements do portão (0a lock, 0b releitura) e o `upsert`
      // acontecem no mesmo `tx`. Se o `upsert` saísse da transação, a corrida
      // que o lock existe para fechar voltaria — é o BLOQUEADOR da 9ª rodada.
      await service.registrarNaoHouve('c1', 'oc1', 'u-prof', true);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      expect(tx.chamada.upsert).toHaveBeenCalledTimes(1);
    });

    it('recusa sem gravar quando a ocorrência aponta para outra turma', async () => {
      // Guarda defensiva: se a ocorrência mudou de turma entre o lock e a
      // releitura, o lock na mão não é o da turma certa.
      let n = 0;
      tx.$queryRaw = jest.fn(() => {
        n += 1;
        if (n === 1) return Promise.resolve([{ id: 't1' }]);
        return Promise.resolve([
          {
            origemTurmaId: 'OUTRA-TURMA',
            data: diaRelativo(-1),
            horaInicio: new Date('1970-01-01T00:00:00.000Z'),
            statusPagamento: 'pendente_pagamento',
            professorId: 'p1',
          },
        ]);
      });

      await expect(
        service.registrarNaoHouve('c1', 'oc1', 'u-prof', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

/**
 * **ACHADO 1 DA VALIDAÇÃO CRUZADA (ALTA) — a volta pelo `GET`.**
 *
 * O ciclo inteiro da SPEC-030 é: registrar → reler → a tela mostra "aula não
 * realizada". A metade da ida tinha 18 provas; **a volta não tinha nenhuma**,
 * e estava quebrada.
 *
 * `chamada()` colapsava a completude num ternário de dois casos — `completa`,
 * ou tudo o mais vira `desconhecida`. `nao_houve` caía no "tudo o mais",
 * então o professor registrava e recebia de volta o aviso de **chamada
 * legada, confira e salve de novo**: o oposto exato do que ele acabara de
 * dizer, e um convite a desfazer sem querer.
 *
 * **Por que nenhuma prova pegou:** a do `Cliente` mockava `getChamada` já
 * devolvendo `nao_houve`. Ela dublou justamente a parte sob julgamento — e
 * ficou verde provando que a tela sabe pintar um valor que o servidor nunca
 * mandava.
 */
describe('PresencaService.chamada — a completude que volta (SPEC-030)', () => {
  function servicoComCabecalho(
    completude: string | null,
    presencas: unknown[] = [],
  ) {
    const prisma = {
      professor: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
      ocupacaoQuadra: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'oc1',
          origemTurmaId: 't1',
          origemTipo: 'TURMA',
          statusPagamento: 'pendente_pagamento',
          data: diaRelativo(-1),
          horaInicio: new Date('1970-01-01T00:00:00.000Z'),
          horaFim: new Date('1970-01-01T23:59:00.000Z'),
        }),
      },
      presenca: { findMany: jest.fn().mockResolvedValue(presencas) },
      turmaAluno: { findMany: jest.fn().mockResolvedValue([]) },
      chamada: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            completude === null
              ? null
              : { ocupacaoId: 'oc1', completude, updatedAt: new Date(0) },
          ),
      },
    } as unknown as PrismaService;
    return new PresencaService(prisma);
  }

  it('cabeçalho `nao_houve` volta como `nao_houve` — NÃO como `desconhecida`', async () => {
    const resposta = await servicoComCabecalho('nao_houve').chamada(
      'c1',
      'u-prof',
      'oc1',
    );

    expect(resposta.completude).toBe('nao_houve');
  });

  it('os outros três casos continuam como eram', async () => {
    // O par negativo. Sem ele, "devolve o valor do cabeçalho sempre" passaria
    // na prova acima e quebraria o legado — que é justamente o caso em que
    // presença SEM cabeçalho tem de virar `desconhecida`.
    await expect(
      servicoComCabecalho('completa').chamada('c1', 'u-prof', 'oc1'),
    ).resolves.toMatchObject({ completude: 'completa' });

    await expect(
      servicoComCabecalho('desconhecida').chamada('c1', 'u-prof', 'oc1'),
    ).resolves.toMatchObject({ completude: 'desconhecida' });

    // Nada registrado: `null` é estado real ("não lançada"), não ausência.
    await expect(
      servicoComCabecalho(null).chamada('c1', 'u-prof', 'oc1'),
    ).resolves.toMatchObject({ completude: null });
  });

  it('LEGADO — presença SEM cabeçalho continua virando `desconhecida`', async () => {
    const resposta = await servicoComCabecalho(null, [
      {
        alunoId: 'a1',
        status: 'presente',
        updatedAt: new Date(0),
        aluno: { usuario: { nome: 'Ana' } },
      },
    ]).chamada('c1', 'u-prof', 'oc1');

    expect(resposta.completude).toBe('desconhecida');
  });
});

/**
 * **REQ-005 / D4 — a volta.** A spec declarou `nao_houve` reversível e o
 * prompt de validação cruzada listou isso como buraco: *"a tela relê depois
 * de gravar, mas ninguém provou que o `PUT` seguinte não bate com a
 * INV-019"*.
 *
 * O caso real é banal e é o que torna a prova necessária: o professor toca na
 * linha errada, marca a aula de terça como não realizada, e precisa desfazer.
 * Se o `PUT` seguinte devolvesse `409 CHAMADA_DESATUALIZADA`, a única saída
 * seria recarregar — e ele não saberia disso.
 *
 * **O ciclo é provado inteiro, sem fixar a versão na mão:** a versão que o
 * `PUT` recebe é a que o `GET` devolveu. Escrever `'0'` ali provaria que o
 * serviço aceita a string que eu escolhi, não que as duas metades concordam.
 */
describe('PresencaService — desfazer `nao_houve` (REQ-005)', () => {
  const MATRICULADOS = [
    { alunoId: 'a1', aluno: { usuario: { nome: 'Ana' } } },
    { alunoId: 'a2', aluno: { usuario: { nome: 'Bruno' } } },
  ];

  function servicoComCabecalho(completude: string | null) {
    const cabecalho =
      completude === null
        ? null
        : { ocupacaoId: 'oc1', completude, updatedAt: new Date(1000) };
    const ocupacao = {
      id: 'oc1',
      origemTurmaId: 't1',
      origemTipo: 'TURMA',
      statusPagamento: 'pendente_pagamento',
      data: diaRelativo(-1),
      horaInicio: new Date('1970-01-01T00:00:00.000Z'),
      horaFim: new Date('1970-01-01T23:59:00.000Z'),
    };
    const upsertDoCabecalho: jest.Mock<
      Promise<unknown>,
      [ArgsDoUpsert]
    > = jest.fn();
    let statement = 0;
    const tx = {
      presenca: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      chamada: {
        findUnique: jest.fn().mockResolvedValue(cabecalho),
        upsert: upsertDoCabecalho,
      },
      turmaAluno: { findMany: jest.fn().mockResolvedValue(MATRICULADOS) },
      $queryRaw: jest.fn(() => {
        statement += 1;
        if (statement % 2 === 1) {
          return Promise.resolve([{ id: 't1' }]);
        }
        return Promise.resolve([
          {
            origemTurmaId: 't1',
            data: ocupacao.data,
            horaInicio: ocupacao.horaInicio,
            statusPagamento: ocupacao.statusPagamento,
            professorId: 'p1',
          },
        ]);
      }),
    };
    const prisma = {
      professor: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
      ocupacaoQuadra: { findFirst: jest.fn().mockResolvedValue(ocupacao) },
      presenca: { findMany: jest.fn().mockResolvedValue([]) },
      turmaAluno: { findMany: jest.fn().mockResolvedValue(MATRICULADOS) },
      chamada: { findUnique: jest.fn().mockResolvedValue(cabecalho) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    return { service: new PresencaService(prisma), upsertDoCabecalho };
  }

  it('a versão que o GET devolve é aceita pelo PUT — sem 409', async () => {
    const { service, upsertDoCabecalho } = servicoComCabecalho('nao_houve');

    // 1. a tela relê, como faz depois de registrar
    const lida = await service.chamada('c1', 'u-prof', 'oc1');
    expect(lida.completude).toBe('nao_houve');
    // 2. e ela mostra os DOIS alunos para marcar: com `nao_houve` o piso é a
    //    união (não o snapshot), então há o que salvar de volta.
    expect(lida.alunos).toHaveLength(2);

    // 3. o professor marca todo mundo e salva, com a versão que recebeu
    await expect(
      service.salvarChamada('c1', 'u-prof', 'oc1', lida.versao, [
        { alunoId: 'a1', status: 'presente' },
        { alunoId: 'a2', status: 'ausente' },
      ]),
    ).resolves.toBeDefined();

    // 4. e o cabeçalho volta a ser uma chamada de verdade
    const args = upsertDoCabecalho.mock.calls[0][0];
    expect(args.update).toMatchObject({
      completude: 'completa',
      esperados: 2,
    });
  });

  it('salvar SEM todos os alunos continua sendo recusado', async () => {
    // O par negativo. Sem ele, um piso que virasse vazio ao desfazer passaria
    // na prova acima — e a DEF-002 (chamada gravada pela metade) voltaria
    // justamente pelo caminho novo.
    const { service } = servicoComCabecalho('nao_houve');
    const lida = await service.chamada('c1', 'u-prof', 'oc1');

    await expect(
      service.salvarChamada('c1', 'u-prof', 'oc1', lida.versao, [
        { alunoId: 'a1', status: 'presente' },
      ]),
    ).rejects.toMatchObject({ response: { code: 'CHAMADA_INCOMPLETA' } });
  });

  it('versão velha continua batendo em 409 — a INV-019 não afrouxou', async () => {
    const { service } = servicoComCabecalho('nao_houve');

    await expect(
      service.salvarChamada('c1', 'u-prof', 'oc1', 'versao-de-outra-tela', [
        { alunoId: 'a1', status: 'presente' },
        { alunoId: 'a2', status: 'ausente' },
      ]),
    ).rejects.toMatchObject({ response: { code: 'CHAMADA_DESATUALIZADA' } });
  });
});

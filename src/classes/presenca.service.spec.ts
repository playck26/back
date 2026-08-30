import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { PresencaService } from './presenca.service';

// TEST (SPEC-014): unit tests de `presencas` com Prisma mockado.
//
// ATENÇÃO ao ler estes testes: mock **não tem constraint**. INV-015 (par
// único) e a metade de INV-016 que proíbe presença em reserva avulsa são
// impostas pelo banco (UNIQUE, CHECK e FK composta) e provadas por
// violação no dry-run da migration, não aqui. O que se prova aqui é a
// lógica que o banco não pode expressar: janela de datas, versão, escopo
// do professor e composição da chamada.

interface TxMock {
  presenca: { findMany: jest.Mock; upsert: jest.Mock };
  chamada: { findUnique: jest.Mock; upsert: jest.Mock };
  turmaAluno: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
}

// SPEC-015/AC-000i — `salvarChamada` **não** usa mais
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

function buildMocks() {
  const estado: EstadoDaOcorrencia = {
    ocupacao: ocupacao(),
    professorIdDaTurma: 'p1',
  };
  // Ímpar = 0a (o lock), par = 0b (a releitura). Alterna em vez de contar
  // uma vez só, para que um teste que chame `salvarChamada` duas vezes não
  // caia num estado impossível.
  let statement = 0;
  const tx: TxMock = {
    presenca: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    chamada: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    turmaAluno: { findMany: jest.fn() },
    $queryRaw: jest.fn(() => {
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
          statusPagamento: oc.statusPagamento,
          professorId: estado.professorIdDaTurma,
        },
      ]);
    }),
  };
  const prisma = {
    professor: { findFirst: jest.fn() },
    turma: { findFirst: jest.fn() },
    ocupacaoQuadra: { findFirst: jest.fn(), findMany: jest.fn() },
    turmaAluno: { findMany: jest.fn() },
    presenca: { findMany: jest.fn().mockResolvedValue([]) },
    chamada: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
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
    horaInicio: new Date('1970-01-01T09:00:00.000Z'),
    horaFim: new Date('1970-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('PresencaService (SPEC-014)', () => {
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
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    // O `GET` monta a lista com o nome do aluno; o `PUT` só usa `alunoId`.
    // Um mock só serve os dois, e é o que permite os testes irem por
    // `GET -> PUT` em vez de fixar a versão na mão.
    (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
      { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno 1' } } },
      { alunoId: 'a2', aluno: { usuario: { nome: 'Aluno 2' } } },
    ]);
  });

  // SPEC-015/INV-026: o padrão passou a ser a turma **inteira** (a1 e a2).
  // Antes era um aluno só — e a suíte inteira passava, o que é a prova de
  // que nada cobrava completude. A DEF-002 morava exatamente aqui.
  // SPEC-015/AC-000j — `versao` é string OPACA, e o teste não deve saber
  // montá-la. Desde a v8 ela inclui o cabeçalho e a impressão digital da
  // matrícula; fixar `'0'` aqui fazia a suíte inteira bater em 409 e, pior,
  // um teste que recalcula a versão do jeito que o serviço calcula não
  // consegue pegar erro nenhum na regra da versão. Então o caminho é o do
  // produto: `GET` primeiro, `PUT` com o que ele devolveu.
  const versaoAtual = async () =>
    (await service.chamada('c1', 'u1', 'oc1')).versao;

  const salvar = async (
    itens: {
      alunoId: string;
      status: 'presente' | 'ausente' | 'justificado';
    }[] = [
      { alunoId: 'a1', status: 'presente' },
      { alunoId: 'a2', status: 'presente' },
    ],
    versao?: string,
  ) =>
    service.salvarChamada(
      'c1',
      'u1',
      'oc1',
      versao ?? (await versaoAtual()),
      itens,
    );

  describe('INV-018 — quem escreve', () => {
    it('recusa usuário com papel de professor mas sem ficha na empresa', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(salvar()).rejects.toBeInstanceOf(ForbiddenException);
    });

    // O `professorId` entra no WHERE. Ocorrência de colega devolve 404, não
    // 403 — 403 confirmaria que ela existe, e o professor mapearia a grade
    // dos colegas por tentativa e erro.
    it('ocorrência de turma de colega devolve 404', async () => {
      armarOcupacao(prisma, estado, null);

      await expect(salvar()).rejects.toBeInstanceOf(NotFoundException);
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
    it('recusa aula futura (o toque na linha errada da grade)', async () => {
      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(1) }));

      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_FUTURA' },
      });
    });

    it('aceita a aula de hoje', async () => {
      armarOcupacao(prisma, estado, ocupacao());

      await expect(salvar()).resolves.toMatchObject({ total: 2 });
    });

    it('aceita aula de 7 dias atrás e recusa a de 8', async () => {
      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(-7) }));
      await expect(salvar()).resolves.toMatchObject({ total: 2 });

      armarOcupacao(prisma, estado, ocupacao({ data: diaRelativo(-8) }));
      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_ANTIGA' },
      });
    });
  });

  describe('INV-016 — a metade que é regra de escrita', () => {
    it('recusa chamada em aula cancelada', async () => {
      armarOcupacao(prisma, estado, ocupacao({ statusPagamento: 'cancelado' }));

      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_CANCELADA' },
      });
    });
  });

  describe('AC-006 — só aluno alocado', () => {
    beforeEach(() => {
      armarOcupacao(prisma, estado, ocupacao());
    });

    // "nada é gravado": a chamada inteira falha. Gravar os válidos e
    // recusar o resto deixaria a aula meio marcada, e o professor sem saber
    // qual metade valeu.
    it('recusa a chamada inteira e não grava nada', async () => {
      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'intruso', status: 'presente' },
        ]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(tx.presenca.upsert).not.toHaveBeenCalled();
    });

    it('recusa o mesmo aluno duas vezes no corpo', async () => {
      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'a1', status: 'ausente' },
        ]),
      ).rejects.toMatchObject({ response: { code: 'ALUNO_REPETIDO' } });
    });

    // A decisão registrada na spec: alocação é o único requisito.
    // `alunos.status` e `vinculo` não bloqueiam — quem assistiu segunda e
    // foi desligado terça esteve lá na segunda.
    it('não consulta status nem vínculo do aluno', async () => {
      await salvar();

      expect(prisma.turmaAluno.findMany).toHaveBeenCalledWith({
        where: { turmaId: 't1' },
        select: { alunoId: true },
      });
    });
  });

  describe('INV-019 — versão otimista', () => {
    beforeEach(() => {
      armarOcupacao(prisma, estado, ocupacao());
    });

    it('recusa com 409 quando a chamada mudou desde a leitura', async () => {
      tx.presenca.findMany.mockResolvedValueOnce([
        { updatedAt: new Date(1_700_000_000_000) },
      ]);

      await expect(salvar()).rejects.toBeInstanceOf(ConflictException);
      expect(tx.presenca.upsert).not.toHaveBeenCalled();
    });

    // A conferência acontece **dentro** da transação. Fora dela sobraria a
    // janela entre ler e gravar, que é a corrida que este controle existe
    // para fechar.
    it('confere a versão dentro da transação', async () => {
      await salvar();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.presenca.findMany).toHaveBeenCalled();
    });

    // SPEC-015/AC-000j — `versao` é OPACA. Este teste fixava
    // `'1:1700000000000'` e quebrou quando a v8 acrescentou a impressão
    // digital da matrícula. Fixar formato é transformar detalhe interno em
    // contrato: o teste falhava por uma mudança pretendida, e não teria
    // pegado nada se o formato ficasse igual e o VALOR errasse.
    //
    // O que importa é a propriedade, e é ela que está aqui: a versão
    // devolvida **muda** depois da gravação. Sem isso, salvar duas vezes na
    // mesma tela bateria em 409 contra a própria escrita anterior — que é a
    // razão de o servidor devolver a versão nova.
    it('devolve versão nova depois de gravar', async () => {
      const antes = await versaoAtual();
      tx.presenca.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ updatedAt: new Date(1_700_000_000_000) }]);

      const res = (await salvar(undefined, antes)) as { versao: string };

      expect(typeof res.versao).toBe('string');
      expect(res.versao.length).toBeGreaterThan(0);
      expect(res.versao).not.toBe(antes);
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
  // SPEC-015/DEF-002 — a correção. O defeito não era um caso de borda: a
  // UI mandava só os alunos em que o professor tocou, e o servidor gravava
  // sem perguntar pelo resto.
  describe('INV-026/INV-027 — chamada completa e o cabeçalho', () => {
    beforeEach(() => {
      armarOcupacao(prisma, estado, ocupacao());
    });

    it('recusa chamada que não cobre todos os esperados, e não grava nada', async () => {
      await expect(
        salvar([{ alunoId: 'a1', status: 'presente' }]),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CHAMADA_INCOMPLETA',
          alunoIds: ['a2'],
        }),
      });

      expect(tx.presenca.upsert).not.toHaveBeenCalled();
      expect(tx.chamada.upsert).not.toHaveBeenCalled();
    });

    // AC-000e: quem cai aqui na janela entre os dois deploys está com o
    // bundle antigo e não tem como saber disso. A mensagem tem de dizer o
    // que fazer, não só que deu errado.
    it('a mensagem do 422 é acionável para cliente antigo', async () => {
      await expect(
        salvar([{ alunoId: 'a1', status: 'presente' }]),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          message: expect.stringContaining('Atualize o app'),
        }),
      });
    });

    it('grava o cabeçalho como completa, com os esperados, na mesma transação', async () => {
      await salvar();

      expect(tx.chamada.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ocupacaoId: 'oc1' },
          create: expect.objectContaining({
            completude: 'completa',
            esperados: 2,
            origemTipo: 'TURMA',
          }),
          update: expect.objectContaining({
            completude: 'completa',
            esperados: 2,
          }),
        }),
      );
    });

    // AC-000b — antes da correção isto era recusado: o aluno removido caía
    // em ALUNO_FORA_DA_TURMA e a chamada dele ficava sem conserto. Os
    // esperados são a **união** justamente por isso.
    it('aceita corrigir a chamada de quem saiu da turma depois', async () => {
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno 1' } } },
      ]);
      // `a2` saiu da turma, mas tem registro: o `GET` devolve a união, e é
      // dela que sai a versão que o `PUT` usa.
      const registradas = [
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Aluno 1' } },
        },
        {
          alunoId: 'a2',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Saiu Depois' } },
        },
      ];
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue(registradas);
      tx.presenca.findMany.mockResolvedValue(registradas);

      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'a2', status: 'ausente' },
        ]),
      ).resolves.toMatchObject({ total: 2 });
    });

    // O par do teste acima: a união não é frouxidão — quem nunca esteve na
    // turma nem foi registrado continua barrado.
    it('continua recusando aluno que não é da turma nem tem registro', async () => {
      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'a2', status: 'presente' },
          { alunoId: 'estranho', status: 'presente' },
        ]),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ALUNO_FORA_DA_TURMA' }),
      });
    });

    // AC-000g — sem o cabeçalho na versão, promover `desconhecida` para
    // `completa` não mudaria a versão, e duas abas se sobrescreveriam no
    // caso exato que a INV-019 existe para pegar.
    it('a versão enxerga mudança só no cabeçalho', async () => {
      tx.chamada.findUnique.mockResolvedValue({
        completude: 'desconhecida',
        esperados: null,
        updatedAt: new Date(1_700_000_000_000),
      });

      await expect(salvar()).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

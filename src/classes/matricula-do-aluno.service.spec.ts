import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatriculaDoAlunoService } from './matricula-do-aluno.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';

/**
 * SPEC-023 — as provas de o aluno entrar e sair de turma sozinho.
 *
 * **O que estas provas NÃO cobrem, e está declarado:** a concorrência
 * (REQ-003). Duas pessoas na última vaga não se provam com dublê — o
 * `FOR UPDATE` só existe contra um Postgres de verdade, e aqui ele é uma
 * `$queryRaw` mockada. A prova de concorrência é a TASK-008 e roda contra
 * banco real, no molde do FIT-001.
 *
 * Isto não é rodapé: **foi exatamente esse tipo de vão que deixou o DEF-013
 * subir para produção** — dois testes existiam, passavam, e o laço que
 * atravessa a rede morava entre os dois dublês.
 */

interface TxMock {
  $queryRaw: jest.Mock;
  aluno: { findFirst: jest.Mock };
  empresa: { findUniqueOrThrow: jest.Mock };
  turmaAluno: {
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  ocupacaoQuadra: { findFirst: jest.Mock };
  // SPEC-031/D16, passo 4: a configuracao e lida pelo MESMO `tx`.
  configOperacaoEmpresa: { findUnique: jest.Mock };
}

const EMPRESA = 'e0000000-0000-4000-8000-000000000001';
const TURMA = 'a0000000-0000-4000-8000-000000000002';
const USUARIO = 'u0000000-0000-4000-8000-000000000003';

function montar(opcoes?: {
  /** SPEC-031: `undefined` = empresa sem configuracao; numero = prazo em horas. */
  prazoAulaHoras?: number;
  /** SPEC-031: a ocorrencia relevante que o banco devolve, ou `null`. */
  ocorrencia?: {
    id: string;
    data: Date;
    horaInicio: Date;
    horaFim: Date;
  } | null;
  vinculo?: string;
  statusDaTurma?: string;
  capacidade?: number;
  alocados?: number;
  jaAlocado?: boolean;
  limite?: number | null;
  minhasTurmas?: number;
  temAulaHoje?: boolean;
  turmaExiste?: boolean;
}) {
  const o = {
    vinculo: 'aprovado',
    statusDaTurma: 'ativa',
    capacidade: 8,
    alocados: 3,
    jaAlocado: false,
    limite: null as number | null,
    minhasTurmas: 0,
    temAulaHoje: false,
    turmaExiste: true,
    ...opcoes,
  };

  const tx: TxMock = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(
        o.turmaExiste
          ? [{ id: TURMA, capacidade: o.capacidade, status: o.statusDaTurma }]
          : [],
      ),
    aluno: { findFirst: jest.fn() },
    // Padrao: empresa SEM configuracao — que e o estado da maioria hoje, e o
    // ramo em que a regra `AULA_HOJE` do rollout passo 1 continua valendo.
    configOperacaoEmpresa: {
      findUnique: jest.fn().mockResolvedValue(
        o.prazoAulaHoras === undefined
          ? null
          : {
              prazoCancelamentoAulaHoras: o.prazoAulaHoras,
              prazoCancelamentoReservaHoras: null,
            },
      ),
    },
    empresa: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ limiteTurmasPorAluno: o.limite }),
    },
    turmaAluno: {
      findFirst: jest
        .fn()
        .mockResolvedValue(o.jaAlocado ? { id: 'alocacao-1' } : null),
      // A contagem por turma (capacidade) e a contagem do aluno (limite) são
      // o mesmo método com `where` diferente — o dublê responde pelo `where`
      // para não trocar uma pela outra.
      count: jest
        .fn()
        .mockImplementation((args: { where: object }) =>
          Promise.resolve(
            'alunoId' in args.where ? o.minhasTurmas : o.alocados,
          ),
        ),
      create: jest.fn().mockResolvedValue({ id: 'nova' }),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    ocupacaoQuadra: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          o.ocorrencia !== undefined
            ? o.ocorrencia
            : o.temAulaHoje
              ? { id: 'ocupacao-1' }
              : null,
        ),
    },
  };

  const prisma = {
    aluno: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'aluno-1', vinculo: o.vinculo }),
    },
    $transaction: jest.fn((cb: (t: TxMock) => unknown) => cb(tx)),
  } as unknown as PrismaService;

  // SPEC-031/TASK-004: o servico passou a ler a configuracao de operacao pelo
  // MESMO `tx` (D16, passo 4). O real sobre o prisma mockado basta — o mock ja
  // devolve `null` por padrao, que e "empresa sem configuracao".
  return {
    service: new MatriculaDoAlunoService(
      prisma,
      new ConfigOperacaoService(prisma),
    ),
    tx,
  };
}

async function codigoDoErro(promessa: Promise<unknown>) {
  try {
    await promessa;
    return 'NAO_LANCOU';
  } catch (erro) {
    const resposta = (erro as { getResponse?: () => unknown }).getResponse?.();
    return (resposta as { code?: string })?.code ?? 'SEM_CODIGO';
  }
}

describe('entrar', () => {
  it('entra quando turma ativa tem vaga e o aluno está aprovado', async () => {
    const { service, tx } = montar();

    await service.entrar(EMPRESA, USUARIO, TURMA);

    expect(tx.turmaAluno.create).toHaveBeenCalledWith({
      data: { turmaId: TURMA, alunoId: 'aluno-1' },
    });
  });

  it('é idempotente: entrar onde já está não cria segunda linha', async () => {
    // Toque duplo em conexão ruim é o caso real, e entrar duas vezes é o
    // mesmo estado.
    const { service, tx } = montar({ jaAlocado: true });

    await service.entrar(EMPRESA, USUARIO, TURMA);

    expect(tx.turmaAluno.create).not.toHaveBeenCalled();
  });

  it('recusa aluno pendente de aprovação', async () => {
    const { service } = montar({ vinculo: 'pendente' });

    await expect(
      service.entrar(EMPRESA, USUARIO, TURMA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      codigoDoErro(
        montar({ vinculo: 'pendente' }).service.entrar(EMPRESA, USUARIO, TURMA),
      ),
    ).resolves.toBe('ALUNO_NAO_APROVADO');
  });

  it('recusa turma inativa', async () => {
    await expect(
      codigoDoErro(
        montar({ statusDaTurma: 'inativa' }).service.entrar(
          EMPRESA,
          USUARIO,
          TURMA,
        ),
      ),
    ).resolves.toBe('TURMA_INATIVA');
  });

  it('recusa quando a turma está cheia', async () => {
    await expect(
      codigoDoErro(
        montar({ capacidade: 4, alocados: 4 }).service.entrar(
          EMPRESA,
          USUARIO,
          TURMA,
        ),
      ),
    ).resolves.toBe('TURMA_CHEIA');
  });

  it('recusa quando o aluno atingiu o limite do clube', async () => {
    await expect(
      codigoDoErro(
        montar({ limite: 2, minhasTurmas: 2 }).service.entrar(
          EMPRESA,
          USUARIO,
          TURMA,
        ),
      ),
    ).resolves.toBe('LIMITE_DE_TURMAS');
  });

  it('limite null não limita, e é o padrão', async () => {
    const { service, tx } = montar({ limite: null, minhasTurmas: 99 });

    await service.entrar(EMPRESA, USUARIO, TURMA);

    expect(tx.turmaAluno.create).toHaveBeenCalled();
  });

  it('turma de outra empresa é 404, nunca 403', async () => {
    // Dizer "existe mas não é sua" já entrega informação sobre o outro
    // clube (INV-023b).
    const { service } = montar({ turmaExiste: false });

    await expect(
      service.entrar(EMPRESA, USUARIO, TURMA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('quem já está na turma não ouve que ela está cheia', async () => {
    // A ordem das checagens É a mensagem: o problema de quem já entrou não
    // é a vaga.
    const { service, tx } = montar({
      jaAlocado: true,
      capacidade: 4,
      alocados: 4,
    });

    await expect(
      service.entrar(EMPRESA, USUARIO, TURMA),
    ).resolves.toBeDefined();
    expect(tx.turmaAluno.create).not.toHaveBeenCalled();
  });
});

describe('sair', () => {
  it('sai quando a turma não tem aula hoje', async () => {
    const { service, tx } = montar({ jaAlocado: true, temAulaHoje: false });

    await service.sair(EMPRESA, USUARIO, TURMA);

    expect(tx.turmaAluno.delete).toHaveBeenCalledWith({
      where: { id: 'alocacao-1' },
    });
  });

  it('recusa sair no dia da aula', async () => {
    const { service, tx } = montar({ jaAlocado: true, temAulaHoje: true });

    await expect(
      codigoDoErro(service.sair(EMPRESA, USUARIO, TURMA)),
    ).resolves.toBe('AULA_HOJE');
    expect(tx.turmaAluno.delete).not.toHaveBeenCalled();
  });

  it('a aula de hoje é procurada por ocupação, ignorando cancelada', async () => {
    // A ocupação é o encontro já materializado numa data real. Perguntar ao
    // `dia_semana` exigiria aritmética de calendário e daria a resposta
    // errada quando a ocupação foi cancelada.
    const { service, tx } = montar({ jaAlocado: true });

    await service.sair(EMPRESA, USUARIO, TURMA);

    const chamadas = tx.ocupacaoQuadra.findFirst.mock.calls as unknown[][];
    const filtro = chamadas[0][0] as {
      where: { statusPagamento: unknown; origemTipo: string };
    };
    expect(filtro.where.origemTipo).toBe('TURMA');
    expect(filtro.where.statusPagamento).toEqual({ not: 'cancelado' });
  });

  it('sair de onde não se está é 404, não silêncio', async () => {
    // Silenciar esconderia bug de tela.
    const { service } = montar({ jaAlocado: false });

    await expect(service.sair(EMPRESA, USUARIO, TURMA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a saída também trava a linha da turma', async () => {
    // Não é sobre capacidade: é o par do lock que `salvarChamada` pega.
    // Quem não pede lock não respeita lock — foi o cenário 5 do
    // `bloq7-concorrencia.ts`.
    const { service, tx } = montar({ jaAlocado: true });

    await service.sair(EMPRESA, USUARIO, TURMA);

    expect(tx.$queryRaw).toHaveBeenCalled();
  });
});

describe('disponíveis', () => {
  it('marca o motivo do bloqueio em vez de esconder a turma', async () => {
    const prisma = {
      aluno: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'aluno-1', vinculo: 'aprovado' }),
      },
      empresa: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ limiteTurmasPorAluno: null }),
      },
      turma: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: TURMA,
            nome: 'Cheia',
            status: 'ativa',
            capacidade: 2,
            encontros: [],
            _count: { alunos: 2 },
          },
        ]),
      },
      turmaAluno: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const [turma] = await new MatriculaDoAlunoService(
      prisma,
      new ConfigOperacaoService(prisma),
    ).disponiveis(EMPRESA, USUARIO);

    // Some com ela e a pessoa vai perguntar no WhatsApp por que a turma das
    // 18h sumiu.
    expect(turma.nome).toBe('Cheia');
    expect(turma.podeEntrar).toBe(false);
    expect(turma.motivo).toBe('TURMA_CHEIA');
    expect(turma.matriculados).toBe(2);
    expect(turma.capacidade).toBe(2);
  });

  it('aluno pendente vê a lista, e vê o porquê', async () => {
    // Esconder a lista dele seria dizer que o clube não tem turmas.
    const prisma = {
      aluno: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'aluno-1', vinculo: 'pendente' }),
      },
      empresa: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ limiteTurmasPorAluno: null }),
      },
      turma: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: TURMA,
            nome: 'Iniciantes',
            status: 'ativa',
            capacidade: 8,
            encontros: [],
            _count: { alunos: 1 },
          },
        ]),
      },
      turmaAluno: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const [turma] = await new MatriculaDoAlunoService(
      prisma,
      new ConfigOperacaoService(prisma),
    ).disponiveis(EMPRESA, USUARIO);

    expect(turma.motivo).toBe('ALUNO_NAO_APROVADO');
    expect(turma.podeEntrar).toBe(false);
  });
});

describe('o que estas provas não provam', () => {
  it('ConflictException é a família dos erros de regra (não 500)', async () => {
    const { service } = montar({ capacidade: 1, alocados: 1 });

    await expect(
      service.entrar(EMPRESA, USUARIO, TURMA),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * SPEC-031/REQ-003 — o ramo NOVO: empresa **com** prazo configurado.
 *
 * O relógio é fixo e a ocorrência é construída em cima dele. Nunca relativo:
 * um teste que soma horas ao `Date.now()` real muda de resposta conforme a
 * hora em que o CI roda, e este projeto já perdeu um dia com isso — o
 * `fit-005` quebrava às 00:03 de Brasília.
 */
describe('sair — com prazo configurado (SPEC-031)', () => {
  const AGORA = new Date('2026-10-05T15:00:00.000Z'); // 12:00 no fuso do clube
  const DIA = new Date('2026-10-05T00:00:00.000Z');
  /** `hh:mm` do clube como o Prisma devolve `@db.Time`: epoch + hora. */
  const hora = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m, 0, 0));

  const ocorrenciaAs = (h: number, m = 0) => ({
    id: 'ocorrencia-1',
    data: DIA,
    horaInicio: hora(h, m),
    horaFim: hora(h + 1, m),
  });

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(AGORA);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('AC-006: dentro do prazo recusa com PRAZO_DE_CANCELAMENTO', async () => {
    // Prazo 2h; a aula começa às 13h e agora são 12h → 60 minutos.
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 2,
      ocorrencia: ocorrenciaAs(13),
    });

    await expect(
      codigoDoErro(service.sair(EMPRESA, USUARIO, TURMA)),
    ).resolves.toBe('PRAZO_DE_CANCELAMENTO');
    expect(tx.turmaAluno.delete).not.toHaveBeenCalled();
  });

  it('fora do prazo, sai', async () => {
    // Aula às 18h, agora 12h → 360 minutos, e o prazo pede 120.
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 2,
      ocorrencia: ocorrenciaAs(18),
    });

    await service.sair(EMPRESA, USUARIO, TURMA);
    expect(tx.turmaAluno.delete).toHaveBeenCalled();
  });

  it('AC-009: EXATAMENTE no limite, sai', async () => {
    // Aula às 14h, agora 12h → 120 minutos, e o prazo pede 120.
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 2,
      ocorrencia: ocorrenciaAs(14),
    });

    await service.sair(EMPRESA, USUARIO, TURMA);
    expect(tx.turmaAluno.delete).toHaveBeenCalled();
  });

  /**
   * D15 — a aula **em andamento** vence a da semana seguinte, e a antecedência
   * dela é negativa. É o caso que a v2 da spec deixava passar: lido como
   * "próxima ocorrência estritamente futura", o aluno sairia durante a aula.
   */
  /**
   * **A escolha dos números aqui é o teste.** Aula das 11h às 13h, agora 12h,
   * prazo de 1h: a antecedência correta é **−60**, e recusa. Se alguém tornar
   * a antecedência positiva (um `Math.abs`, um `início − agora` invertido),
   * vira **+60**, que é `>= 60` e **passa** — o teste fica vermelho.
   *
   * A primeira versão deste caso usava prazo de 2h, e aí `|−60| = 60 < 120`
   * recusava dos dois jeitos: passava com o defeito injetado. Teste de
   * concorrência ou de sinal precisa de números que separem as hipóteses.
   */
  it('AC-010b: aula EM ANDAMENTO recusa — e o SINAL da antecedencia importa', async () => {
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 1,
      ocorrencia: { ...ocorrenciaAs(11), horaFim: hora(13) },
    });

    await expect(
      codigoDoErro(service.sair(EMPRESA, USUARIO, TURMA)),
    ).resolves.toBe('PRAZO_DE_CANCELAMENTO');
    expect(tx.turmaAluno.delete).not.toHaveBeenCalled();
  });

  it('AC-010: sem ocorrencia futura, sai mesmo com prazo', async () => {
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 2,
      ocorrencia: null,
    });

    await service.sair(EMPRESA, USUARIO, TURMA);
    expect(tx.turmaAluno.delete).toHaveBeenCalled();
  });

  /**
   * D16, passo 4: a configuração é lida pelo **mesmo `tx`**, e **sem
   * `FOR UPDATE`**. Ler por outra conexão segurando o lock da turma é o
   * defeito que a SPEC-034 pagou caro; travar a configuração faria toda saída
   * de turma serializar contra toda outra da mesma empresa.
   */
  it('D16: a configuracao e lida pelo mesmo tx', async () => {
    const { service, tx } = montar({
      jaAlocado: true,
      prazoAulaHoras: 2,
      ocorrencia: ocorrenciaAs(18),
    });

    await service.sair(EMPRESA, USUARIO, TURMA);
    expect(tx.configOperacaoEmpresa.findUnique).toHaveBeenCalled();
  });
});

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatriculaDoAlunoService } from './matricula-do-aluno.service';

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
}

const EMPRESA = 'e0000000-0000-4000-8000-000000000001';
const TURMA = 'a0000000-0000-4000-8000-000000000002';
const USUARIO = 'u0000000-0000-4000-8000-000000000003';

function montar(opcoes?: {
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
        .mockResolvedValue(o.temAulaHoje ? { id: 'ocupacao-1' } : null),
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

  return { service: new MatriculaDoAlunoService(prisma), tx };
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

    const [turma] = await new MatriculaDoAlunoService(prisma).disponiveis(
      EMPRESA,
      USUARIO,
    );

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

    const [turma] = await new MatriculaDoAlunoService(prisma).disponiveis(
      EMPRESA,
      USUARIO,
    );

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

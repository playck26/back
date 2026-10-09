import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  AcessoService,
  hashDeSegredoDescartado,
} from '../../acesso/acesso.service';
import { MemoriaProvedorDeEmail } from '../../email/memoria-provedor-de-email';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  ImportacaoDeAlunosService,
  type GanchosDaImportacao,
} from './importacao-de-alunos.service';

/**
 * SPEC-083/D4 e AC-014 — **nenhum bcrypt dentro da transação, provado por
 * estrutura, e não por tempo** (achado DOR-083-R1-03).
 *
 * Um teste de tempo ("300 linhas não dão `P2028`") passa numa máquina rápida
 * com o hash dentro da transação, e falha numa lenta com ele fora. Este não
 * depende de máquina: o `$transaction` é envolvido para marcar o intervalo
 * REAL do callback, e o `bcrypt.hash` e o `bcrypt.hashSync` são espionados no
 * **próprio módulo `bcrypt`** que o serviço (e o `AcessoService`) importam.
 * Qualquer chamada que COMECE dentro do intervalo reprova — por qualquer
 * caminho: função auxiliar, alias, outro módulo (S6).
 *
 * **O controle de que o espião está no módulo certo:** o caso correto tem de
 * registrar chamadas FORA do intervalo, e exatamente as que a D4 manda (uma
 * por linha não convidada, mais uma do segredo descartado). Sem elas, o
 * espião estaria num objeto que ninguém usa, e "zero dentro" não provaria
 * nada. E o detector se prova pelo avesso: um hash disparado de dentro da
 * transação, por uma função auxiliar de outro módulo, é visto.
 */

// O objeto do módulo, e não o espaço de nomes do `import * as`: o
// `esModuleInterop` lê as propriedades do módulo por getter, então o espião
// posto aqui é o que o serviço chama.
const moduloDoBcrypt = jest.requireActual<typeof bcrypt>('bcrypt');

const MODELOS = {
  remetente: 'convites@unit.teste.local',
  responderPara: 'suporte@unit.teste.local',
  urlCliente: 'https://cliente.unit.teste.local',
};
const GESTOR = '9a000000-0000-4000-8000-000000000001';

/** Uma chamada ao bcrypt, e se ela começou dentro do callback da transação. */
interface ChamadaDoBcrypt {
  funcao: 'hash' | 'hashSync';
  dentro: boolean;
}

/**
 * O serviço sobre um Prisma de mentira, com o `$transaction` envolvido. A
 * profundidade sobe na entrada do callback e desce quando a promessa dele
 * termina (com sucesso ou não): é o intervalo real em que a transação está
 * aberta, e não o trecho de código que a escreve.
 */
function montar(ganchos: GanchosDaImportacao = {}) {
  let profundidade = 0;
  const chamadas: ChamadaDoBcrypt[] = [];

  jest.spyOn(moduloDoBcrypt, 'hash').mockImplementation((() => {
    chamadas.push({ funcao: 'hash', dentro: profundidade > 0 });
    return Promise.resolve('$2b$04$hash-de-teste-que-nao-confere-nada');
  }) as never);
  jest.spyOn(moduloDoBcrypt, 'hashSync').mockImplementation(() => {
    chamadas.push({ funcao: 'hashSync', dentro: profundidade > 0 });
    return '$2b$04$hash-sincrono-de-teste';
  });

  const turmas = [
    { id: 't-terca', nome: 'Terça', capacidade: 10, nivelId: 'n1' },
  ];
  const leitores = {
    nivel: {
      findMany: jest.fn().mockResolvedValue([{ id: 'n1', nome: 'Iniciante' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'n1', nome: 'Iniciante' }),
    },
    turmaAluno: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ocupacaoQuadra: { findMany: jest.fn().mockResolvedValue([]) },
    faltaAvisada: { findMany: jest.fn().mockResolvedValue([]) },
    reposicaoDeAula: { findMany: jest.fn().mockResolvedValue([]) },
    // SPEC-086 — a conferência dos e-mails sob a trava, dentro da transação.
    usuario: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sqlDe = (primeiro: unknown, resto: unknown[]) =>
    Array.isArray(primeiro)
      ? Prisma.sql(primeiro as readonly string[], ...(resto as Prisma.Sql[]))
      : (primeiro as Prisma.Sql);
  const tx = {
    ...leitores,
    $queryRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) => {
      const { sql, values } = sqlDe(primeiro, resto);
      const arranjos = values.filter((v): v is string[] => Array.isArray(v));
      if (sql.includes('FROM empresas e2')) {
        const [tabelas, ids] = arranjos;
        return Promise.resolve(
          tabelas.map((tabela, k) => ({
            tabela,
            achado: ids[k],
            empresa_nome: 'Clube',
          })),
        );
      }
      if (sql.includes('FROM turmas t2')) {
        return Promise.resolve(
          turmas.map((t) => ({ ...t, nivel_id: t.nivelId, status: 'ativa' })),
        );
      }
      if (sql.includes('INSERT INTO alunos')) {
        return Promise.resolve(arranjos[0].map((id) => ({ id })));
      }
      return Promise.resolve([{ ok: 1 }]);
    }),
    $executeRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) => {
      const { values } = sqlDe(primeiro, resto);
      const primeiroArranjo = values.find((v): v is unknown[] =>
        Array.isArray(v),
      );
      return Promise.resolve(primeiroArranjo?.length ?? 0);
    }),
  };
  const prisma = {
    ...leitores,
    usuario: { findMany: jest.fn().mockResolvedValue([]) },
    turma: { findMany: jest.fn().mockResolvedValue(turmas) },
    conviteDeAcesso: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      profundidade += 1;
      try {
        return await fn(tx);
      } finally {
        profundidade -= 1;
      }
    }),
  };
  const memoria = new MemoriaProvedorDeEmail();
  const servico = new ImportacaoDeAlunosService(
    prisma as unknown as PrismaService,
    new AcessoService(prisma as unknown as PrismaService, memoria, MODELOS),
    memoria,
    MODELOS,
    ganchos,
  );
  return { servico, prisma, chamadas };
}

/** Quatro linhas: duas convidadas (3 e 5), duas com senha, três na turma. */
const ARQUIVO = [
  'nome;email;turma',
  'Ana;ana@x.com;Terça',
  'Beto;beto@x.com;Terça',
  'Cris;cris@x.com;',
  'Dani;dani@x.com;Terça',
].join('\r\n');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SPEC-083/AC-014 — nenhum bcrypt dentro da transação (estrutural)', () => {
  it('**nenhuma chamada começa dentro do callback**, e as de fora são as da D4: uma por linha com senha, e UMA para todas as convidadas', async () => {
    const { servico, prisma, chamadas } = montar();

    const { criados } = await servico.importar('c1', ARQUIVO, {
      gestorId: GESTOR,
      convidar: '3,5',
    });

    // A transação aconteceu: sem ela, "zero dentro" seria verdade vazia.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(criados).toHaveLength(4);

    expect(chamadas.filter((c) => c.dentro)).toEqual([]);
    // O controle: o espião está no módulo que o serviço usa. Duas linhas com
    // senha (2 e 4) e um segredo descartado para as convidadas (3 e 5): três
    // hashes, todos fora. Um hash por convidada seria quatro.
    expect(chamadas).toEqual([
      { funcao: 'hash', dentro: false },
      { funcao: 'hash', dentro: false },
      { funcao: 'hash', dentro: false },
    ]);
  });

  it('sem convidada, um hash por linha, e nenhum para o segredo', async () => {
    const { servico, chamadas } = montar();
    await servico.importar('c1', ARQUIVO, { gestorId: GESTOR });
    expect(chamadas.filter((c) => c.dentro)).toEqual([]);
    expect(chamadas).toHaveLength(4);
  });

  it('todas convidadas: UM hash por arquivo, fora da transação', async () => {
    const { servico, chamadas } = montar();
    await servico.importar('c1', ARQUIVO, {
      gestorId: GESTOR,
      convidar: '2,3,4,5',
    });
    expect(chamadas).toEqual([{ funcao: 'hash', dentro: false }]);
  });

  /**
   * **O detector pelo avesso** — a forma da S6, sem tocar o serviço: um hash
   * disparado de DENTRO da transação por uma função auxiliar de outro módulo
   * (`hashDeSegredoDescartado`, do `AcessoService`), sem `bcrypt.hash`
   * escrito no callback. O gancho `aoTravar` roda na sessão da importação,
   * entre a trava do clube e as escritas.
   */
  it.each([
    [
      'hash, por uma função auxiliar de outro módulo',
      async () => {
        await hashDeSegredoDescartado();
      },
      'hash',
    ],
    [
      'hashSync, por alias',
      () => {
        const apelido = (dado: string) => moduloDoBcrypt.hashSync(dado, 4);
        apelido('qualquer');
      },
      'hashSync',
    ],
  ] as const)(
    'controle: um %s dentro da transação é VISTO',
    async (_caso, dentroDaTransacao, funcao) => {
      const { servico, chamadas } = montar({
        aoTravar: dentroDaTransacao,
      });
      await servico.importar('c1', ARQUIVO, {
        gestorId: GESTOR,
        convidar: '3,5',
      });
      expect(chamadas.filter((c) => c.dentro)).toEqual([
        { funcao, dentro: true },
      ]);
    },
  );
});

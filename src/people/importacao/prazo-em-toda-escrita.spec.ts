import { Prisma } from '@prisma/client';
import { AcessoService } from '../../acesso/acesso.service';
import {
  MARCADOR_DO_PRAZO,
  RESTO_DO_PRAZO,
} from '../../common/lock/prazo-de-espera';
import { MemoriaProvedorDeEmail } from '../../email/memoria-provedor-de-email';
import type { PrismaService } from '../../prisma/prisma.service';
import { ImportacaoDeAlunosService } from './importacao-de-alunos.service';

/**
 * SPEC-083/D3, passo 4, e AC-051 — **o prazo em toda escrita, e o `COMMIT`
 * protegido**, pelo cliente que grava cada instrução da transação.
 *
 * O `lock_timeout` vale por ESPERA, e um `INSERT` em lote pode esperar duas
 * vezes (DOR-083-R2-01). O conserto é uma instrução, imediatamente antes de
 * cada escrita, que fixa o `statement_timeout` e o `lock_timeout` no que sobra
 * de `playck.prazo`. Este gate percorre a transação nos dois ramos — com e sem
 * convidados — e afirma:
 *
 * - cada escrita vem **imediatamente** depois do ajuste (nenhuma instrução no
 *   meio, e nenhuma escrita sem o seu: a S13 tira o da segunda e cai aqui);
 * - o ajuste fixa os DOIS parâmetros, locais à transação, com o valor
 *   derivado de `playck.prazo` no servidor — o texto de `RESTO_DO_PRAZO`, e
 *   nenhum número vindo do Back (a instrução não leva parâmetro nenhum);
 * - a última instrução antes do `COMMIT` devolve o `statement_timeout` ao da
 *   sessão, lido da variável em que o primeiro ajuste o guardou.
 *
 * Que o banco obedece (o `57014` que cancela a escrita, e um `COMMIT` que não
 * é cancelado) é a metade de banco do AC-051, em
 * `test/banco/spec-083-importacao.db-spec.ts`.
 */

const MODELOS = {
  remetente: 'convites@unit.teste.local',
  responderPara: 'suporte@unit.teste.local',
  urlCliente: 'https://cliente.unit.teste.local',
};
const GESTOR = '9a000000-0000-4000-8000-000000000001';

/** Uma instrução que a transação mandou, ou o marcador de início e fim. */
interface Instrucao {
  sql: string;
  valores: unknown[];
}

const COMECO: Instrucao = { sql: 'BEGIN', valores: [] };
const FIM: Instrucao = { sql: 'COMMIT', valores: [] };

/** O cliente gravador: o Prisma de mentira, que guarda o texto de cada ida. */
function gravador() {
  const instrucoes: Instrucao[] = [];
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
  const gravar = (primeiro: unknown, resto: unknown[]): Instrucao => {
    const montado = Array.isArray(primeiro)
      ? Prisma.sql(primeiro as readonly string[], ...(resto as Prisma.Sql[]))
      : (primeiro as Prisma.Sql);
    const i = { sql: montado.sql, valores: montado.values };
    instrucoes.push(i);
    return i;
  };
  const arranjos = (i: Instrucao) =>
    i.valores.filter((v): v is string[] => Array.isArray(v));
  // **Sem API de modelo de escrita no `tx`**: uma escrita por ela lançaria
  // aqui ("não é função"), e o caso ficaria vermelho.
  const tx = {
    ...leitores,
    $queryRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) => {
      const i = gravar(primeiro, resto);
      if (i.sql.includes('FROM empresas e2')) {
        const [tabelas, ids] = arranjos(i);
        return Promise.resolve(
          tabelas.map((tabela, k) => ({
            tabela,
            achado: ids[k],
            empresa_nome: 'Clube',
          })),
        );
      }
      if (i.sql.includes('FROM turmas t2')) {
        return Promise.resolve(
          turmas.map((t) => ({ ...t, nivel_id: t.nivelId, status: 'ativa' })),
        );
      }
      if (i.sql.includes('INSERT INTO alunos')) {
        return Promise.resolve(arranjos(i)[0].map((id) => ({ id })));
      }
      return Promise.resolve([{ ok: 1 }]);
    }),
    $executeRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) =>
      Promise.resolve(arranjos(gravar(primeiro, resto))[0]?.length ?? 0),
    ),
  };
  const prisma = {
    ...leitores,
    usuario: { findMany: jest.fn().mockResolvedValue([]) },
    turma: { findMany: jest.fn().mockResolvedValue(turmas) },
    conviteDeAcesso: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      instrucoes.push(COMECO);
      const r = await fn(tx);
      instrucoes.push(FIM);
      return r;
    }),
  };
  const memoria = new MemoriaProvedorDeEmail();
  const servico = new ImportacaoDeAlunosService(
    prisma as unknown as PrismaService,
    new AcessoService(prisma as unknown as PrismaService, memoria, MODELOS),
    memoria,
    MODELOS,
  );
  /** Só as instruções de dentro da transação, com os marcadores. */
  const daTransacao = () =>
    instrucoes.slice(instrucoes.indexOf(COMECO), instrucoes.indexOf(FIM) + 1);
  return { servico, daTransacao };
}

const ESCRITA = /^\s*WITH[\s\S]*?\bINSERT\s+INTO\s+(\w+)/;
const tabelaEscrita = (i: Instrucao) => ESCRITA.exec(i.sql)?.[1] ?? null;

/** Sem quebras e espaços repetidos: o texto, e não a indentação, é o contrato. */
const plano = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const RESTO = plano(RESTO_DO_PRAZO.sql);

/**
 * O ajuste, com os dois parâmetros, os dois valores e o `is_local`. Um
 * `set_config` com o valor errado (um número fixo, o `lock_timeout` só, o
 * `false` que vazaria para a sessão) não casa.
 */
function ehAjusteDoPrazo(i: Instrucao): boolean {
  const s = plano(i.sql);
  return (
    s.includes(`set_config('statement_timeout', ${RESTO}, true)`) &&
    s.includes(`set_config('lock_timeout', ${RESTO}, true)`) &&
    i.valores.length === 0
  );
}

const VARIAVEL_DA_SESSAO = /current_setting\('(playck\.[a-z_]+)', true\)/;

const ARQUIVO = [
  'nome;email;turma',
  'Ana;ana@x.com;Terça',
  'Beto;beto@x.com;',
  'Cris;cris@x.com;Terça',
].join('\r\n');

describe.each([
  {
    ramo: 'com convidados',
    convidar: '3',
    escritas: ['usuarios', 'alunos', 'turma_alunos', 'convites_de_acesso'],
  },
  {
    ramo: 'sem convidados',
    convidar: undefined,
    escritas: ['usuarios', 'alunos', 'turma_alunos'],
  },
])('SPEC-083/AC-051 — $ramo', ({ convidar, escritas }) => {
  let transacao: Instrucao[];

  beforeAll(async () => {
    const { servico, daTransacao } = gravador();
    await servico.importar('c1', ARQUIVO, { gestorId: GESTOR, convidar });
    transacao = daTransacao();
  });

  it('a transação foi percorrida até o COMMIT, e as escritas são exatamente as do ramo, na ordem da D3', () => {
    expect(transacao[0]).toBe(COMECO);
    expect(transacao[transacao.length - 1]).toBe(FIM);
    expect(
      transacao.map(tabelaEscrita).filter((t): t is string => t !== null),
    ).toEqual(escritas);
  });

  it('**cada escrita vem IMEDIATAMENTE depois do ajuste do prazo**', () => {
    const semAjuste = transacao.flatMap((i, k) =>
      tabelaEscrita(i) !== null && !ehAjusteDoPrazo(transacao[k - 1])
        ? [tabelaEscrita(i)]
        : [],
    );
    expect(semAjuste).toEqual([]);
    // E nenhum ajuste solto: um por escrita.
    expect(transacao.filter(ehAjusteDoPrazo)).toHaveLength(escritas.length);
  });

  it('o valor do ajuste é derivado de `playck.prazo` no servidor, com piso de 1 ms', () => {
    // `RESTO_DO_PRAZO` é a conta da SPEC-082: o que falta até o marcador,
    // `greatest(1, …)`. Conferido aqui para que um `RESTO` trocado por outra
    // coisa não passe só por ser igual a si mesmo.
    expect(RESTO).toContain(`current_setting('${MARCADOR_DO_PRAZO}')`);
    expect(RESTO).toContain('greatest(1,');
    expect(RESTO).toContain('clock_timestamp()');
  });

  it('cada escrita carrega também o marcador do prazo no WITH (o gate da SPEC-082)', () => {
    const semMarcador = transacao
      .filter((i) => tabelaEscrita(i) !== null)
      .filter(
        (i) =>
          !/WITH\s+prazo_r\s+AS\s+MATERIALIZED/.test(i.sql) ||
          !i.sql.includes(MARCADOR_DO_PRAZO),
      )
      .map(tabelaEscrita);
    expect(semMarcador).toEqual([]);
  });

  it('**a última instrução antes do COMMIT devolve o statement_timeout ao da sessão**', () => {
    const ultima = transacao[transacao.length - 2];
    const s = plano(ultima.sql);
    const variavel = VARIAVEL_DA_SESSAO.exec(s)?.[1];
    expect(variavel).toBeDefined();
    expect(s).toBe(
      `SELECT set_config('statement_timeout', coalesce(nullif(current_setting('${variavel}', true), ''), current_setting('statement_timeout')), true) AS st`,
    );
    expect(ultima.valores).toEqual([]);
    // A variável lida é a que o primeiro ajuste grava, com o valor da sessão
    // ANTES de qualquer troca: sem isso, "devolver ao padrão" seria devolver
    // ao prazo curto.
    const primeiroAjuste = plano(
      (transacao.find(ehAjusteDoPrazo) as Instrucao).sql,
    );
    expect(primeiroAjuste).toContain(
      `FROM (SELECT set_config('${variavel}', coalesce(nullif(current_setting('${variavel}', true), ''), current_setting('statement_timeout')), true) AS guardado) g`,
    );
  });
});

describe('SPEC-083/AC-051 — controle do gravador', () => {
  it('o detector reprova uma escrita sem o ajuste antes (a forma da S13)', () => {
    const ajuste = { sql: 'x', valores: [] };
    const escrita = {
      sql: 'WITH prazo_r AS MATERIALIZED (…) INSERT INTO alunos (id)',
      valores: [],
    };
    expect(ehAjusteDoPrazo(ajuste)).toBe(false);
    expect(tabelaEscrita(escrita)).toBe('alunos');
  });

  it('o ajuste com só o lock_timeout (a forma da S12) não é ajuste', () => {
    const soLock = {
      sql: `SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO.sql}, true) AS lt`,
      valores: [],
    };
    expect(ehAjusteDoPrazo(soLock)).toBe(false);
  });

  it('o ajuste com um valor vindo do Back (parâmetro) não é ajuste', () => {
    const comParametro = {
      sql: `SELECT set_config('statement_timeout', ${RESTO_DO_PRAZO.sql}, true), set_config('lock_timeout', ${RESTO_DO_PRAZO.sql}, true), $1`,
      valores: ['2000ms'],
    };
    expect(ehAjusteDoPrazo(comParametro)).toBe(false);
  });
});

/**
 * SPEC-083/TASK-005c — **as contas entram em ordem de e-mail**, e não na do
 * arquivo. Duas importações com os mesmos e-mails em ordens opostas fechavam
 * um ciclo no índice único de `usuarios.email` (cada `INSERT` em lote esperando
 * a linha ainda não confirmada da outra), e o `40P01` subia `500`. A prova de
 * banco é `test/banco/spec-083-importacao-concorrente.db-spec.ts`; esta é a
 * forma, pelo mesmo gravador: o arranjo de e-mails do `INSERT` vem ordenado, as
 * outras colunas acompanham a linha delas, e o aluno de cada linha continua
 * apontando para a conta do e-mail dela.
 */
describe('SPEC-083/TASK-005c — o INSERT de usuários em ordem determinística', () => {
  const FORA_DE_ORDEM = [
    'nome;email;telefone',
    'Zeca;zeca@x.com;111',
    'Ana;ana@x.com;222',
    'Mara;mara@x.com;333',
  ].join('\r\n');

  let usuarios: Instrucao;
  let alunos: Instrucao;

  beforeAll(async () => {
    const { servico, daTransacao } = gravador();
    await servico.importar('c1', FORA_DE_ORDEM, { gestorId: GESTOR });
    const transacao = daTransacao();
    usuarios = transacao.find(
      (i) => tabelaEscrita(i) === 'usuarios',
    ) as Instrucao;
    alunos = transacao.find((i) => tabelaEscrita(i) === 'alunos') as Instrucao;
  });

  const arranjosDe = (i: Instrucao) =>
    i.valores.filter((v): v is string[] => Array.isArray(v));

  it('os e-mails vão ordenados, e nome e telefone acompanham a linha de cada um', () => {
    const [, emails, , nomes, telefones] = arranjosDe(usuarios);
    expect(emails).toEqual(['ana@x.com', 'mara@x.com', 'zeca@x.com']);
    expect(nomes).toEqual(['Ana', 'Mara', 'Zeca']);
    expect(telefones).toEqual(['222', '333', '111']);
  });

  it('a ordem do arranjo é a de inserção, dita no SQL', () => {
    const s = plano(usuarios.sql);
    expect(s).toContain(
      'WITH ORDINALITY AS d(id, email, senha_hash, nome, telefone, ord)',
    );
    expect(s).toMatch(/ORDER BY d\.ord$/);
  });

  it('o aluno de cada linha aponta para a conta do e-mail dela (os ids não se embaralham)', () => {
    const [ids, emails] = arranjosDe(usuarios);
    const contaDo = new Map(emails.map((e, k) => [e, ids[k]]));
    const [, usuarioDoAluno] = arranjosDe(alunos);
    // `alunos` segue a ordem do arquivo: Zeca, Ana, Mara.
    expect(usuarioDoAluno).toEqual([
      contaDo.get('zeca@x.com'),
      contaDo.get('ana@x.com'),
      contaDo.get('mara@x.com'),
    ]);
    expect(new Set(ids).size).toBe(3);
  });
});

import { Prisma } from '@prisma/client';
import type { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { CourtsService } from '../../src/courts/courts.service';
import type { ReposicaoService } from '../../src/classes/reposicao.service';
import { ClassesService } from '../../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';

/**
 * SPEC-082 — **o cliente de transação que registra cada instrução**, no molde
 * do `def-013-orcamento-da-transacao.spec.ts`: os três serviços leitores são
 * os de verdade, e só o que cruzaria a rede é dublado.
 *
 * Serve a duas provas:
 *
 * - **AC-011** — conta as idas dentro das três transações, com `BEGIN` e
 *   `COMMIT`, no ramo mais caro;
 * - **AC-017** — guarda o TEXTO de cada instrução crua (com as partes
 *   `Prisma.raw`/`Prisma.sql` já montadas), para o gate conferir que toda
 *   escrita e todo lock de linha levam o prazo.
 *
 * **Instrução crua que o dublê não conhece devolve `[]` e é contada**, e não
 * lança: uma ida nova dentro da transação tem de ficar vermelha pelo TETO, e
 * não por um erro do dublê (o CI vermelho pelo motivo errado é o DEF-VC031-02).
 * Chamada de modelo sem resposta, ao contrário, lança — ela não teria como
 * devolver um valor que o serviço aceite.
 */

export const EMPRESA = 'c0000000-0000-4000-8000-000000000082';
export const TURMA = 'a0000000-0000-4000-8000-000000000082';
export const ALUNO = 'b0000000-0000-4000-8000-000000000082';
export const USUARIO = 'd0000000-0000-4000-8000-000000000082';
export const NIVEL = 'e0000000-0000-4000-8000-000000000082';
export const LINHA_DA_FILA = 'f0000000-0000-4000-8000-000000000082';

export interface Cenario {
  /** Gestores ativos do clube: cada um recebe uma linha do aviso (SPEC-078). */
  gestoresAtivos: number;
  /** O aluno tem nível próprio (senão, o primeiro do clube). */
  alunoComNivelProprio: boolean;
  /** A turma tem uma aula futura (a conferência de aula lotada roda). */
  ocorrenciaFutura: boolean;
  /** `limite_turmas_por_aluno` do clube; `null` pula a contagem do aluno. */
  limite: number | null;
  /** A contagem da turma dentro da transação diz "cheia". */
  turmaCheiaNaTransacao: boolean;
}

/**
 * **O ramo mais caro do AC-011**: gestor ativo (dois, para o aviso gravar
 * mais de uma linha), aluno com nível próprio, ocorrência futura na turma — e
 * limite de turmas no clube, que acrescenta a contagem do aluno em `entrar` e
 * em `confirmar`.
 */
export const RAMO_MAIS_CARO: Cenario = {
  gestoresAtivos: 2,
  alunoComNivelProprio: true,
  ocorrenciaFutura: true,
  limite: 2,
  turmaCheiaNaTransacao: false,
};

export interface Ida {
  /** `BEGIN`, `COMMIT`, `ROLLBACK`, `$queryRaw`, `$executeRaw` ou `modelo.metodo`. */
  rotulo: string;
  /** O SQL montado, para as instruções cruas; `null` nas de modelo. */
  sql: string | null;
  valores: unknown[];
}

const ESCRITAS_DE_MODELO =
  /^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/;

export function ehEscritaDeModelo(ida: Ida): boolean {
  const [, metodo] = ida.rotulo.split('.');
  return (
    ida.sql === null && metodo !== undefined && ESCRITAS_DE_MODELO.test(metodo)
  );
}

function montarSql(
  primeiro: unknown,
  resto: unknown[],
): { sql: string; valores: unknown[] } {
  if (Array.isArray(primeiro)) {
    const montado = Prisma.sql(
      primeiro as readonly string[],
      ...(resto as Prisma.Sql[]),
    );
    return { sql: montado.sql, valores: montado.values };
  }
  const pronto = primeiro as Prisma.Sql;
  return { sql: pronto.sql, valores: pronto.values };
}

export interface OpcoesDoCliente {
  /**
   * Falha injetada: devolve o erro que a ida deve lançar, ou `undefined` para
   * ela seguir. A ida que falha é registrada mesmo assim (ela cruzou a rede).
   */
  falha?: (ida: Ida) => Error | undefined;
}

export function clienteContado(
  cenario: Cenario,
  opcoesDoCliente: OpcoesDoCliente = {},
) {
  const idas: Ida[] = [];
  const opcoesDasTransacoes: unknown[] = [];
  let linhasEmNotificacoes = 0;
  const gestores = Array.from({ length: cenario.gestoresAtivos }, (_, i) => ({
    usuario_id: `90000000-0000-4000-8000-00000000008${i}`,
  }));

  function responderCru(sql: string, valores: unknown[]): unknown {
    if (sql.includes("set_config('playck.prazo'")) return [{ ok: 1 }];
    if (sql.trimStart().startsWith('/* matricula-com-prazo */')) {
      const [alunoId, turmaId] = valores as string[];
      return [
        { id: 'matricula-nova', turmaId, alunoId, createdAt: new Date() },
      ];
    }
    if (/FROM\s+turmas\b/.test(sql) && sql.includes('FOR UPDATE')) {
      return [
        {
          id: TURMA,
          capacidade: 10,
          status: 'ativa',
          nivel_id: NIVEL,
        },
      ];
    }
    if (/FROM\s+lista_de_espera\b/.test(sql) && sql.includes('FOR UPDATE')) {
      return [{ estado: 'chamado', vencida: false }];
    }
    if (/FROM\s+usuarios\b/.test(sql) && sql.includes("'company_admin'")) {
      return gestores;
    }
    if (/INSERT\s+INTO\s+notificacoes\b/.test(sql)) {
      // O `INSERT` grava uma linha por destinatário do `unnest`.
      const destinatarios = valores.find((v) => Array.isArray(v)) as
        unknown[] | undefined;
      const gravadas = destinatarios?.length ?? 0;
      linhasEmNotificacoes += gravadas;
      return gravadas;
    }
    if (/UPDATE\s+lista_de_espera\b/.test(sql)) return 1;
    return [];
  }

  const futura = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const modelos: Record<string, Record<string, (args: unknown) => unknown>> = {
    turmaAluno: {
      findFirst: () => null,
      count: (args) =>
        'alunoId' in ((args as { where: object }).where ?? {})
          ? 0
          : cenario.turmaCheiaNaTransacao
            ? 10
            : 3,
      findMany: () => [],
    },
    faltaAvisada: { findMany: () => [] },
    reposicaoDeAula: { findMany: () => [] },
    empresa: {
      findUniqueOrThrow: () => ({ limiteTurmasPorAluno: cenario.limite }),
    },
    aluno: {
      findUniqueOrThrow: () => ({
        nivelId: cenario.alunoComNivelProprio ? NIVEL : null,
      }),
      findFirst: () => ({
        id: ALUNO,
        companyId: EMPRESA,
        nivelId: cenario.alunoComNivelProprio ? NIVEL : null,
        vinculo: 'aprovado',
        status: 'ativo',
      }),
    },
    nivel: { findFirst: () => ({ id: NIVEL, nome: 'Intermediário' }) },
    ocupacaoQuadra: {
      findMany: () =>
        cenario.ocorrenciaFutura
          ? [{ id: 'oc-futura', data: futura, origemTurmaId: TURMA }]
          : [],
    },
  };

  const tx = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (prop === '$queryRaw' || prop === '$executeRaw') {
          return (primeiro: unknown, ...resto: unknown[]) => {
            const { sql, valores } = montarSql(primeiro, resto);
            const ida: Ida = { rotulo: prop, sql, valores };
            idas.push(ida);
            const erro = opcoesDoCliente.falha?.(ida);
            if (erro !== undefined) return Promise.reject(erro);
            return Promise.resolve(responderCru(sql, valores));
          };
        }
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_m, metodo) {
              if (typeof metodo !== 'string' || metodo === 'then') {
                return undefined;
              }
              return (args: unknown) => {
                idas.push({
                  rotulo: `${prop}.${metodo}`,
                  sql: null,
                  valores: [args],
                });
                const responder = modelos[prop]?.[metodo];
                if (!responder) {
                  return Promise.reject(
                    new Error(`dublê sem resposta para ${prop}.${metodo}`),
                  );
                }
                return Promise.resolve(responder(args));
              };
            },
          },
        );
      },
    },
  );

  const prisma = {
    // Fora da transação: não entra no orçamento.
    aluno: {
      findFirst: jest.fn().mockResolvedValue({
        id: ALUNO,
        vinculo: 'aprovado',
        nivelId: cenario.alunoComNivelProprio ? NIVEL : null,
      }),
    },
    listaDeEspera: {
      findFirst: jest.fn().mockResolvedValue({
        id: LINHA_DA_FILA,
        turmaId: TURMA,
        ocupacaoId: null,
        faltaId: null,
      }),
    },
    // A leitura de fora do D5: "não sei dizer que está cheia".
    $queryRaw: jest.fn().mockResolvedValue([{ cheia: false }]),
    $transaction: jest.fn(
      async (cb: (t: unknown) => Promise<unknown>, opcoes?: unknown) => {
        opcoesDasTransacoes.push(opcoes);
        idas.push({ rotulo: 'BEGIN', sql: null, valores: [] });
        try {
          const resultado = await cb(tx);
          idas.push({ rotulo: 'COMMIT', sql: null, valores: [] });
          return resultado;
        } catch (erro) {
          idas.push({ rotulo: 'ROLLBACK', sql: null, valores: [] });
          throw erro;
        }
      },
    ),
  } as unknown as PrismaService;

  const operacao = new ConfigOperacaoService(prisma);
  const matriculas = new MatriculaDoAlunoService(prisma, operacao);
  const turmas = new ClassesService(
    prisma,
    {} as CourtsService,
    { garantirAlunoOperante: jest.fn() } as unknown as StudentsService,
    operacao,
  );
  const fila = new FilaDeEsperaService(
    prisma,
    operacao,
    matriculas,
    {} as ReposicaoService,
  );

  return {
    idas,
    opcoesDasTransacoes,
    linhasEmNotificacoes: () => linhasEmNotificacoes,
    gestores,
    /** Os três caminhos leitores, com os argumentos do cenário. */
    entrar: () => matriculas.entrar(EMPRESA, USUARIO, TURMA),
    allocateStudent: () => turmas.allocateStudent(EMPRESA, TURMA, ALUNO),
    confirmar: () => fila.confirmar(EMPRESA, USUARIO, LINHA_DA_FILA),
  };
}

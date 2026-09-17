import { Prisma, PrismaClient } from '@prisma/client';

/**
 * SPEC-057/TASK-001/D3 — **a CLI operacional da presença automática.**
 *
 *     pnpm presenca:auto -- status
 *     pnpm presenca:auto -- ativar --ambiente producao --instancia <uuid>
 *     pnpm presenca:auto -- pausar --ambiente producao --instancia <uuid>
 *
 * **Lê exclusivamente `PRESENCA_OPERADOR_DATABASE_URL`.** Ausente, sai com 1
 * antes de conectar — nunca recorre a `DATABASE_URL` nem a
 * `MIGRATION_DATABASE_URL`, porque cair na credencial da aplicação ou do
 * migrador seria exatamente a autoridade que a D3 separa.
 *
 * **Nunca executa UPDATE direto.** `ativar` e `pausar` chamam
 * `presenca_auto_alterar`, que confere UUID e ambiente **no banco**. O
 * `--ambiente` comparado com `APP_ENVIRONMENT` aqui é só pré-confirmação local:
 * pega o engano de terminal antes de conectar, e não protege contra banco
 * errado — quem protege é a função (`PA001`/`PA002`).
 *
 * **Não imprime host, usuário, senha nem URL** — nem em erro: a mensagem de
 * falha de conexão do Prisma cita o servidor, então só o código operacional
 * sai.
 */

export const VARIAVEL_DA_CREDENCIAL = 'PRESENCA_OPERADOR_DATABASE_URL';

/** A tabela de erros operacionais da D3, por SQLSTATE. */
export const ERROS_OPERACIONAIS: Record<string, string> = {
  PA001: 'PRESENCA_INSTANCIA_DIVERGENTE',
  PA002: 'PRESENCA_AMBIENTE_DIVERGENTE',
  PA003: 'PRESENCA_CONFIG_AUSENTE',
  PA004: 'PRESENCA_AMBIENTE_NAO_DECLARADO',
  PA005: 'PRESENCA_ARGUMENTO_AUSENTE',
  '42501': 'PRESENCA_SEM_PRIVILEGIO',
  '23514': 'PRESENCA_GUARDA_RECUSOU',
  '23505': 'PRESENCA_SEGUNDA_LINHA',
  '22P02': 'PRESENCA_UUID_INVALIDO',
  '42883': 'PRESENCA_FUNCAO_AUSENTE',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O mínimo de cliente que a CLI usa — um `PrismaClient` serve. */
export type ClienteDoOperador = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$transaction' | '$disconnect'
>;

export interface AmbienteDaCli {
  env: Record<string, string | undefined>;
  conectar: (url: string) => ClienteDoOperador;
  escrever: (linha: string) => void;
}

interface EstadoDaConfig {
  banco: string;
  ambiente: string | null;
  instanciaId: string;
  ativadaEm: Date | null;
  habilitada: boolean;
  podeAlterar: boolean;
}

interface Alteracao {
  o_instancia_id: string;
  o_ambiente: string;
  o_habilitada: boolean;
  o_ativada_em: Date | null;
  o_mudou: boolean;
}

/** Devolve o exit code; nunca lança. */
export async function executarCli(
  argv: readonly string[],
  ambiente: AmbienteDaCli,
): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const comando = args[0];
  const { escrever, env } = ambiente;

  if (comando !== 'status' && comando !== 'ativar' && comando !== 'pausar') {
    escrever(
      'uso: presenca:auto -- status | ativar|pausar --ambiente <nome> --instancia <uuid>',
    );
    return 1;
  }

  const url = env[VARIAVEL_DA_CREDENCIAL];
  if (!url) {
    escrever(`erro: ${VARIAVEL_DA_CREDENCIAL} ausente; nada foi conectado.`);
    return 1;
  }

  let habilitar = false;
  let ambienteInformado = '';
  let instancia = '';
  if (comando !== 'status') {
    habilitar = comando === 'ativar';
    ambienteInformado = valorDe(args, '--ambiente') ?? '';
    instancia = valorDe(args, '--instancia') ?? '';
    if (!ambienteInformado || !instancia) {
      escrever(
        'erro: --ambiente e --instancia são obrigatórios; nada foi conectado.',
      );
      return 1;
    }
    if (!UUID.test(instancia)) {
      escrever('erro: --instancia não é um UUID; nada foi conectado.');
      return 1;
    }
    if (env.APP_ENVIRONMENT !== ambienteInformado) {
      escrever(
        'erro: --ambiente diverge de APP_ENVIRONMENT deste terminal; nada foi conectado.',
      );
      return 1;
    }
  }

  let cliente: ClienteDoOperador | null = null;
  try {
    cliente = ambiente.conectar(url);
    if (comando === 'status') {
      const estado = await lerEstado(cliente);
      escreverEstado(escrever, env.APP_ENVIRONMENT, estado);
      return 0;
    }

    const c = cliente;
    const [alteracao] = await c.$transaction(async (tx) =>
      tx.$queryRawUnsafe<Alteracao[]>(
        `SELECT o_instancia_id::text AS o_instancia_id, o_ambiente, o_habilitada,
                o_ativada_em, o_mudou
           FROM public.presenca_auto_alterar($1::uuid, $2::text, $3::boolean)`,
        instancia,
        ambienteInformado,
        habilitar,
      ),
    );
    escrever(
      alteracao.o_mudou
        ? `ok: presença automática ${habilitar ? 'ATIVADA' : 'PAUSADA'}.`
        : 'ok: sem mudança — a flag já estava assim.',
    );
    escrever(`ambiente:    ${alteracao.o_ambiente}`);
    escrever(`instancia:   ${alteracao.o_instancia_id}`);
    escrever(`habilitada:  ${alteracao.o_habilitada ? 'sim' : 'não'}`);
    escrever(`corte:       ${formatarInstante(alteracao.o_ativada_em)}`);
    return 0;
  } catch (causa) {
    escrever(`erro: ${erroOperacional(causa)}; nenhuma mudança gravada.`);
    return 1;
  } finally {
    if (cliente) {
      await cliente.$disconnect().catch(() => undefined);
    }
  }
}

async function lerEstado(cliente: ClienteDoOperador): Promise<EstadoDaConfig> {
  // Só SELECT: `status` não muta nada, nem com a credencial do operador.
  const linhas = await cliente.$queryRawUnsafe<EstadoDaConfig[]>(
    `SELECT current_database()          AS banco,
            c.ambiente                  AS ambiente,
            c.instancia_id::text        AS "instanciaId",
            c.ativada_em                AS "ativadaEm",
            c.habilitada                AS habilitada,
            has_function_privilege(
              'public.presenca_auto_alterar(uuid, text, boolean)', 'EXECUTE'
            )                           AS "podeAlterar"
       FROM public.config_presenca_automatica c
      WHERE c.id = 1`,
  );
  if (linhas.length === 0) {
    throw new LinhaAusente();
  }
  return linhas[0];
}

class LinhaAusente extends Error {}

function escreverEstado(
  escrever: (linha: string) => void,
  appEnvironment: string | undefined,
  e: EstadoDaConfig,
): void {
  escrever(`APP_ENVIRONMENT local: ${appEnvironment ?? '(não definido)'}`);
  escrever(`banco:                 ${e.banco}`);
  escrever(`ambiente declarado:    ${e.ambiente ?? '(não declarado)'}`);
  escrever(`instancia:             ${e.instanciaId}`);
  escrever(`corte:                 ${formatarInstante(e.ativadaEm)}`);
  escrever(`habilitada:            ${e.habilitada ? 'sim' : 'não'}`);
  escrever(`pode_alterar:          ${e.podeAlterar ? 'sim' : 'não'}`);
}

function formatarInstante(instante: Date | null): string {
  return instante ? new Date(instante).toISOString() : '(nunca ativada)';
}

function valorDe(args: readonly string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

/** SQLSTATE → erro operacional. Nunca devolve texto do driver. */
export function erroOperacional(causa: unknown): string {
  if (causa instanceof LinhaAusente) return ERROS_OPERACIONAIS.PA003;
  if (causa instanceof Prisma.PrismaClientInitializationError) {
    return 'PRESENCA_CONEXAO_FALHOU';
  }
  const sqlstate = sqlstateDe(causa);
  if (sqlstate && ERROS_OPERACIONAIS[sqlstate]) {
    return ERROS_OPERACIONAIS[sqlstate];
  }
  return sqlstate ? `PRESENCA_FALHA_SQLSTATE_${sqlstate}` : 'PRESENCA_FALHA';
}

export function sqlstateDe(causa: unknown): string | null {
  if (causa instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = causa.meta as { code?: string } | undefined;
    if (meta?.code) return meta.code;
  }
  const texto = causa instanceof Error ? causa.message : '';
  const achado = /Code: `([0-9A-Z]{5})`/.exec(texto);
  return achado ? achado[1] : null;
}

/* istanbul ignore next -- ponto de entrada; a lógica é `executarCli`. */
if (require.main === module) {
  void executarCli(process.argv.slice(2), {
    env: process.env,
    conectar: (url) => new PrismaClient({ datasources: { db: { url } } }),

    escrever: (linha) => console.log(linha),
  }).then((codigo) => {
    process.exitCode = codigo;
  });
}

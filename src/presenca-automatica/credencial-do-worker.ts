import type { Prisma } from '@prisma/client';

/**
 * SPEC-057/TASK-001/D3 — **a trava de credencial do worker.**
 *
 * **Isto não é o mecanismo de autoridade.** Quem impede a aplicação de ligar
 * a presença automática são os grants e o trigger da configuração (INV-146).
 * Esta trava protege a **ordem do rollout**: enquanto o processo ainda conecta
 * com credencial de owner ou de operador, o job não fecha nada — porque um
 * processo com essa credencial é exatamente o que a separação de autoridade
 * existe para não ter rodando.
 *
 * Fail-closed: qualquer sinal de privilégio a mais recusa o tick inteiro.
 * Consulta só o catálogo, com a própria conexão do worker.
 */
export const CODIGO_CREDENCIAL_NAO_SEPARADA =
  'PRESENCA_CREDENCIAL_NAO_SEPARADA';

export interface VeredictoDeCredencial {
  separada: boolean;
  /** Os nomes dos sinais que recusaram — nunca o papel, host ou URL. */
  motivos: string[];
}

interface LinhaDoCatalogo {
  superusuario: boolean;
  criaPapel: boolean;
  ignoraRls: boolean;
  escreveNaConfig: boolean;
  mudaFlag: boolean;
  membroDoDono: boolean;
  executaFuncao: boolean;
}

export async function verificarCredencialDoWorker(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<VeredictoDeCredencial> {
  const [linha] = await db.$queryRaw<LinhaDoCatalogo[]>`
    SELECT r.rolsuper                                         AS "superusuario",
           r.rolcreaterole                                    AS "criaPapel",
           r.rolbypassrls                                     AS "ignoraRls",
           (has_table_privilege(c.oid, 'INSERT')
             OR has_table_privilege(c.oid, 'UPDATE')
             OR has_table_privilege(c.oid, 'DELETE')
             OR has_table_privilege(c.oid, 'TRUNCATE'))       AS "escreveNaConfig",
           has_column_privilege(c.oid, 'habilitada', 'UPDATE') AS "mudaFlag",
           pg_has_role(current_user, c.relowner, 'MEMBER')    AS "membroDoDono",
           has_function_privilege(
             'public.presenca_auto_alterar(uuid, text, boolean)',
             'EXECUTE'
           )                                                  AS "executaFuncao"
      FROM pg_catalog.pg_roles r
     CROSS JOIN pg_catalog.pg_class c
     WHERE r.rolname = current_user
       AND c.oid = 'public.config_presenca_automatica'::regclass
  `;
  if (!linha) {
    // Papel sem linha em `pg_roles` não existe; tabela ausente já teria
    // estourado no `regclass`. Recusar é o único lado seguro.
    return { separada: false, motivos: ['catalogo_ilegivel'] };
  }
  const motivos = (
    [
      ['superusuario', linha.superusuario],
      ['cria_papel', linha.criaPapel],
      ['ignora_rls', linha.ignoraRls],
      ['escreve_na_configuracao', linha.escreveNaConfig],
      ['altera_flag', linha.mudaFlag],
      ['membro_do_dono_da_configuracao', linha.membroDoDono],
      ['executa_funcao_operacional', linha.executaFuncao],
    ] as const
  )
    .filter(([, sinal]) => sinal)
    .map(([nome]) => nome);
  return { separada: motivos.length === 0, motivos };
}

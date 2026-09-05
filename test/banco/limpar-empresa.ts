/**
 * DEF-009 (2026-08-24) — a limpeza das suítes de banco, escopada.
 *
 * **Antes daqui, as duas suítes começavam com `DELETE FROM <tabela>` sem
 * `WHERE`** — dez tabelas, o banco inteiro. Foram escritas para o Postgres
 * descartável do CI, e a suposição "isto só roda contra banco efêmero" não
 * estava escrita em lugar nenhum nem imposta por nada.
 *
 * Em 2026-08-24 uma delas rodou contra o Neon de produção e apagou os dados.
 * A digital do acidente foi a própria lista: morreu tudo o que estava nela,
 * sobrou tudo o que não estava (`niveis`, `convites_aluno`,
 * `horarios_funcionamento`) — e o `DELETE FROM usuarios` falhou por FK, que é
 * o único motivo de ainda existir com quem logar.
 *
 * **A trava de host (`exigirBancoLocal`) é o cinto. Isto aqui é o freio:**
 * uma suíte que só apaga a própria empresa não tem como levar mais nada
 * junto, nem quando alguém aponta para o banco errado.
 *
 * A ordem abaixo é a das dependências, filho antes de pai. Ela existe porque
 * quase toda FK para `empresas` é `RESTRICT`: apagar a empresa antes dos
 * filhos não é "ineficiente", é impossível.
 *
 * ## A lista incompleta já custou caro duas vezes
 *
 * A primeira foi o incidente acima. **A segunda foi em 2026-08-26**, quando a
 * SPEC-020 criou `esportes_de_quadra` e `categorias_de_quadra` e ninguém as
 * acrescentou aqui — e a `matriz-raiz`, a rede de regressão da raiz de lock,
 * ficou vermelha inteira com um erro de FK que não tinha nada a ver com lock.
 *
 * O sintoma foi barulhento e o mecanismo é silencioso: **nada obriga esta
 * lista a acompanhar o schema.** Por isso existe `limpar-empresa.db-spec.ts`,
 * que a confere contra o `information_schema` e quebra no dia em que aparecer
 * tabela nova com `company_id` — do mesmo jeito que a AC-017 da SPEC-018 faz
 * com as colunas de mídia.
 */
export interface ClienteSql {
  $executeRawUnsafe(sql: string, ...valores: unknown[]): Promise<number>;
}

/**
 * SPEC-032/TASK-005 — a limpeza passou a precisar de **transação própria**: a
 * válvula das tabelas append-only é um GUC `is_local`, que morre com a
 * transação. Sem transação não há escopo, e o salvo-conduto vazaria para a
 * sessão inteira.
 *
 * A transação é aberta **aqui dentro**, e não nos 32 chamadores, de
 * propósito: exigir que cada um lembrasse de envolver seria a mesma aposta
 * que a lista incompleta já perdeu duas vezes neste arquivo.
 */
interface ComTransacao {
  $transaction<T>(
    fn: (tx: ClienteSql) => Promise<T>,
    opcoes?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

/**
 * SPEC-043 — o canário `FIT-001 Neon` (run 33792486811) morreu AQUI, não
 * no FIT: "Transaction not found ... old closed transaction". A transação
 * interativa do Prisma expira em 5 s por padrão; são ~18 DELETEs mais os
 * `SET ROLE`, e do runner do GitHub (EUA) à Neon (São Paulo) cada
 * statement custa ~200 ms. No Postgres do CI, milissegundos; na Neon, a
 * transação some no meio e o resto falha com esta mensagem. É o tipo de
 * diferença que o canário existe para revelar — e por isso o timeout é
 * explícito e generoso: a limpeza nunca é o que está em julgamento.
 */
const OPCOES_DA_TRANSACAO = { maxWait: 15_000, timeout: 60_000 };

/**
 * As tabelas que a trigger de append-only protege (SPEC-032/INV-061).
 *
 * O `DELETE` delas só passa dentro da transação da limpeza, e **como a role
 * `playck_test_cleanup`** — que só existe no banco de testes, criada pelo
 * `globalSetup`. Ver `bootstrap-role-de-limpeza.ts` para o porquê de não
 * bastar o GUC.
 */
const APPEND_ONLY: ReadonlySet<string> = new Set([
  'eventos_de_ocupacao',
  'acoes_administrativas',
  // SPEC-031/D22/1: `eventos_de_matricula` e a TERCEIRA da familia. Estar em
  // `TABELAS_DA_EMPRESA` NAO poe aqui — sao conjuntos diferentes, e foi o
  // primeiro item da lista de quinze justamente porque isso ja passou batido.
  'eventos_de_matricula',
]);

/**
 * Tabelas com `company_id`, na ordem em que podem ser apagadas.
 * `turma_alunos` não aparece: não tem `company_id` e cai por cascata de
 * `turmas`.
 */
export const TABELAS_DA_EMPRESA = [
  // SPEC-025: ANTES de `ocupacoes_quadra` e de `alunos` — a FK dela e
  // CASCADE, mas a limpeza apaga por `company_id` tabela a tabela, e uma
  // ordem que deixasse a avaliacao para depois esbarraria na empresa.
  'avaliacoes_de_aula',
  'presencas',
  'chamadas',
  // SPEC-032: ANTES de `ocupacoes_quadra` e de `acoes_administrativas` — o
  // evento aponta para as duas por FK composta, com RESTRICT nas duas.
  'eventos_de_ocupacao',
  // SPEC-031/D18: ANTES dos TRES pais — `ocupacoes_quadra`, `alunos` e
  // `empresas` —, porque as quatro FKs dela sao RESTRICT. Quatro rodadas de
  // validacao acharam um pai faltando, um por vez, por listar em vez de
  // ordenar.
  'faltas_avisadas',
  'ocupacoes_quadra',
  'pedidos_reserva',
  // SPEC-031/D21: ANTES de `turmas`, `alunos` e `acoes_administrativas` — tem
  // FK RESTRICT para as tres.
  'eventos_de_matricula',
  'turmas',
  'alunos',
  'professores',
  'horarios_funcionamento',
  'quadras',
  // SPEC-020: DEPOIS de `quadras`, que aponta para os dois por FK composta.
  'esportes_de_quadra',
  'categorias_de_quadra',
  'niveis',
  'convites_aluno',
  'config_pagamento_empresa',
  // SPEC-031/D22/1b: company-scoped com FK RESTRICT para `empresas`. Sem ela
  // os TRES caminhos de limpeza recebem `23503` no `DELETE FROM empresas` —
  // e ela nao estava em nenhum deles.
  'config_operacao_empresa',
  // SPEC-024: ANTES de `usuarios` nao importa (a FK e para `empresas`), mas
  // antes da empresa importa — `contratos_da_empresa` tem ON DELETE RESTRICT
  // de proposito: apagar uma empresa nao pode levar embora o registro de qual
  // texto os alunos aceitaram sem que alguem tenha decidido isso.
  //
  // `aceites` NAO entra: aponta para `usuarios`, com ON DELETE CASCADE, e cai
  // junto com eles. Poe-la aqui seria apagar por um caminho que ja apaga.
  'contratos_da_empresa',
  // SPEC-032: DEPOIS de `eventos_de_ocupacao` (que aponta para ela) e ANTES
  // de `usuarios` (o autor, com RESTRICT).
  'acoes_administrativas',
  'usuarios',
] as const;

/**
 * Apaga tudo o que pertence a uma empresa, e depois a empresa.
 *
 * Recebe o id explicitamente — **não existe versão sem argumento de
 * propósito**. Uma função que limpa "tudo" é a que causou o incidente.
 */
export async function limparEmpresa(
  cliente: ClienteSql,
  companyId: string,
): Promise<void> {
  // O `$transaction` do Prisma e SOBRECARREGADO (array | callback), e
  // sobrecarga nao casa estruturalmente com uma interface de assinatura
  // unica: o TypeScript para na primeira e reclama. O cast e local e o
  // runtime e exatamente o mesmo — a alternativa era espalhar o
  // `$transaction` pelos 32 chamadores.
  const comTransacao = cliente as unknown as ComTransacao;
  await comTransacao.$transaction(async (tx) => {
    for (const tabela of TABELAS_DA_EMPRESA) {
      if (APPEND_ONLY.has(tabela)) {
        // A válvula, e ela é **estreita de propósito**: vale por uma
        // instrução, dentro desta transação, e como uma role que não existe
        // em produção. `RESET ROLE` logo depois para que o resto da limpeza
        // volte a correr como o dono do schema.
        await tx.$executeRawUnsafe(`SET LOCAL ROLE playck_test_cleanup`);
        await tx.$executeRawUnsafe(
          `SELECT set_config('playck.limpeza_append_only', 'on', true)`,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM ${tabela} WHERE company_id = $1::uuid`,
          companyId,
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('playck.limpeza_append_only', '', true)`,
        );
        await tx.$executeRawUnsafe(`RESET ROLE`);
        continue;
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM ${tabela} WHERE company_id = $1::uuid`,
        companyId,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM empresas WHERE id = $1::uuid`,
      companyId,
    );
  }, OPCOES_DA_TRANSACAO);
}

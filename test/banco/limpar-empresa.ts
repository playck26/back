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
 * Tabelas com `company_id`, na ordem em que podem ser apagadas.
 * `turma_alunos` não aparece: não tem `company_id` e cai por cascata de
 * `turmas`.
 */
export const TABELAS_DA_EMPRESA = [
  'presencas',
  'chamadas',
  'ocupacoes_quadra',
  'pedidos_reserva',
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
  for (const tabela of TABELAS_DA_EMPRESA) {
    await cliente.$executeRawUnsafe(
      `DELETE FROM ${tabela} WHERE company_id = $1::uuid`,
      companyId,
    );
  }
  await cliente.$executeRawUnsafe(
    `DELETE FROM empresas WHERE id = $1::uuid`,
    companyId,
  );
}

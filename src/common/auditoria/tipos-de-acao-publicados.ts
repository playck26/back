/**
 * Os valores de `TipoDeAcao` **como o contrato os publica**.
 *
 * ## Por que existe uma lista, e por que ela é UMA
 *
 * O gate do DEF-016 (`contrato-de-resposta.spec.ts`) compara, por conjunto,
 * todo `enum` publicado em `*ResponseDto` com os enums do `schema.prisma`.
 * Publicar um subconjunto — só os valores que "fazem sentido" naquela
 * resposta — reprova ali, e com razão: o cliente gerado do OpenAPI precisa
 * conhecer o enum inteiro que pode chegar no campo.
 *
 * A consequência é que **toda resposta que publica `acao` publica os mesmos
 * catorze valores**. Enquanto a lista morava dentro de um DTO só, isso era
 * invisível; com a SPEC-069 passou a haver uma segunda resposta com o mesmo
 * campo, e duas cópias da mesma lista é exatamente a forma de drift que este
 * projeto já pagou **três vezes no mesmo arquivo** — `turma_aluno_removido`,
 * depois três de uma vez na SPEC-035, depois `turma_professor_alterado`. O
 * gate pegou as três; o custo foi descobrir tarde.
 *
 * **A ordem importa para o diff, não para o gate.** A comparação do DEF-016 é
 * por conjunto (`[AVULSO, TURMA]` e `[TURMA, AVULSO]` são o mesmo contrato),
 * mas o `openapi.json` é versionado e conferido com `git diff --exit-code`:
 * reordenar aqui produziria um diff que não corresponde a mudança nenhuma.
 * A ordem abaixo é a do `schema.prisma`, e valor novo entra **no fim**, pela
 * mesma regra que governa o `ALTER TYPE ADD VALUE`.
 *
 * ## O que este arquivo NÃO decide
 *
 * Quais desses valores de fato aparecem em cada resposta. Isso é por DTO, e
 * cada um diz na própria `description`: no histórico de ocupação nunca
 * aparecem `turma_aluno_removido` nem `turma_professor_alterado` (o alvo
 * técnico deles não é uma ocupação); no histórico de turma, hoje, só aparece
 * `turma_professor_alterado`.
 */
export const TIPOS_DE_ACAO_PUBLICADOS = [
  'reserva_criada',
  'reserva_cancelada',
  // SPEC-034: mover uma reserva e cancelar uma ocorrência de turma são
  // gestos próprios — nenhum dos dois cabia em `reserva_cancelada`.
  'reserva_movida',
  'aula_cancelada',
  'pagamento_confirmado',
  'turma_criada',
  'turma_horario_editado',
  'credito_lancado',
  'credito_retirado',
  // SPEC-031/D21: o gestor tirou o aluno da turma. O alvo técnico dele é uma
  // MATRÍCULA (`eventos_de_matricula`), não uma ocupação.
  'turma_aluno_removido',
  // SPEC-035/D7 — os três gestos que o `status` da turma passou a fazer.
  'turma_inativada',
  'turma_reativada',
  'aula_reativada',
  // SPEC-068/D1 — a troca de professor. Até a SPEC-069 a ação dela não
  // carregava evento nenhum; agora carrega, e é `eventos_de_turma`.
  'turma_professor_alterado',
] as const;

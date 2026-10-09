import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * SPEC-083/D9 — **o tradutor único das violações de unicidade da ficha.**
 *
 * Os caminhos da ficha (enviar o convite; criar a conta do professor sem conta)
 * escrevem pela API de modelo do Prisma, e uma corrida que a aplicação não
 * serializou chega aqui como `P2002`. Duas têm tradução:
 *
 * | o que o banco recusou | vira |
 * |---|---|
 * | as três regras de e-mail da SPEC-086 (`ehViolacaoDeEmail`) | `409 EMAIL_EM_USO` |
 * | `convites_de_acesso_um_vivo_por_usuario` (dois convites vivos) | `409 CONVITE_EM_EMISSAO` |
 *
 * **Qualquer outra violação sobe sem tradução** e vira `500`: um `UNIQUE` que
 * ninguém esperava é defeito a aparecer, e não recusa a explicar por palpite.
 *
 * ## Por modelo E colunas, nunca só pelo código
 *
 * O `P2002` não traz o nome da constraint (achado DOR-083-R2-04), só o modelo
 * e as colunas. **Medido em 2026-10-03 contra o Postgres local, pela API de
 * modelo, dentro e fora de transação interativa** (as duas linhas de
 * `usuarios` remedidas em 2026-10-08, depois da SPEC-086) — e é o
 * `spec-083-corrida-do-professor.db-spec.ts` que mantém a medição viva:
 *
 * | constraint | `meta` |
 * |---|---|
 * | `usuarios_company_id_email_key` (SPEC-086) | `{modelName: 'Usuario', target: ['company_id', 'email']}` |
 * | `usuarios_email_gestao_key` (SPEC-086, índice parcial) | `{modelName: 'Usuario', target: ['email']}` |
 * | `convites_de_acesso_um_vivo_por_usuario` (índice parcial da migration) | `{modelName: 'ConviteDeAcesso', target: ['usuario_id']}` |
 * | `usuarios_pkey` | `{modelName: 'Usuario', target: ['id']}` |
 * | `professores_usuario_id_key` | `{modelName: 'Professor', target: ['usuario_id']}` |
 * | `convites_de_acesso_token_hash_key` | `{modelName: 'ConviteDeAcesso', target: ['token_hash']}` |
 *
 * As três de baixo são o motivo de ler **os dois** campos: a de `professores`
 * tem a mesma coluna do índice de convite, e a PK de `usuarios` e o `UNIQUE`
 * do token têm o mesmo modelo de uma das traduzidas. Quem lesse só a coluna,
 * ou só o modelo, traduziria uma delas errado (S9 é o caso extremo: ler só o
 * código).
 *
 * As colunas são comparadas **exatas, na ordem**. Se uma versão do Prisma
 * mudar a forma do `meta`, nada casa, e o erro sobe como `500` — o lado seguro
 * — em vez de virar um `409` para o motivo errado.
 *
 * **A importação não usa este tradutor:** ela escreve em SQL cru (`P2010`) e
 * trata o `23505` refazendo a conferência (D3, passo 5).
 */

/**
 * O corpo do `409` de e-mail em uso. **Um corpo só**, com a conferência de
 * antes da transação (`TeachersService`): quem perdeu a corrida no `UNIQUE`
 * recebe a mesma resposta de quem perdeu na conferência.
 */
export const EMAIL_EM_USO = Object.freeze({
  statusCode: 409,
  code: 'EMAIL_EM_USO',
  message: 'Este e-mail já tem conta nesta empresa ou pertence a um gestor.',
});

/**
 * SPEC-086 — **a violação de alguma das três regras de e-mail**, pela forma
 * real do erro (medida na validação da spec, e mantida viva pelo
 * `spec-086-unicidade.db-spec.ts`):
 *
 * | constraint | pela API de modelo |
 * |---|---|
 * | `usuarios_company_id_email_key` | `P2002`, `{modelName: 'Usuario', target: ['company_id', 'email']}` |
 * | `usuarios_email_gestao_key` (índice parcial) | `P2002`, `{modelName: 'Usuario', target: ['email']}` |
 * | `usuarios_email_gestao_excl` (`EXCLUDE`) | `PrismaClientUnknownRequestError`, **sem** `code`/`meta`: o nome da constraint só existe na mensagem |
 *
 * O `EXCLUDE` é reconhecido pela **classe e pelo campo `message` do erro**
 * nomeando a constraint (`EXCLUDE_DE_EMAIL_VIOLADO`, IMP-086-R1-01) —
 * casar texto é o último recurso, e fica contido (LIM-086-03: um upgrade do
 * Prisma reabre esta linha, e o db-spec avisa). Um CHECK ou outro `EXCLUDE`
 * também chegam como `Unknown`, e por isso NÃO casam.
 *
 * A importação escreve em SQL cru (`P2010`) e decide pelo SQLSTATE da etapa;
 * ela não passa por aqui.
 */
export function ehViolacaoDeEmail(erro: unknown): boolean {
  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    if (erro.code !== 'P2002') return false;
    const meta = erro.meta as
      { modelName?: unknown; target?: unknown } | undefined;
    const alvo = meta?.target;
    if (meta?.modelName !== 'Usuario' || !Array.isArray(alvo)) return false;
    const colunas = alvo.join(',');
    return colunas === 'company_id,email' || colunas === 'email';
  }
  if (erro instanceof Prisma.PrismaClientUnknownRequestError) {
    return EXCLUDE_DE_EMAIL_VIOLADO.test(erro.message);
  }
  return false;
}

/**
 * IMP-086-R1-01 — **o EXCLUDE de e-mail como a constraint EFETIVAMENTE
 * violada**, e não como um texto qualquer da mensagem.
 *
 * Procurar o nome na mensagem inteira traduzia para `409` um `EXCLUDE` ou
 * `CHECK` alheio cujo DADO trazia esse nome: o `detail` do Postgres repete os
 * valores da linha. Forma medida em 2026-10-08 (Postgres local, este Prisma),
 * igual com `errorFormat` padrão e `'minimal'` — só muda o cabeçalho antes:
 *
 * ```text
 * ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError {
 *   code: "23P01", message: "conflicting key value violates exclusion constraint \"<constraint>\"",
 *   severity: "ERROR", detail: Some("Key (nome)=(<dado>) conflicts with ..."), ... }) })
 * ```
 *
 * A mensagem é o `Debug` do Rust: **toda aspa de um valor sai escapada
 * (`\"`)**, e a barra também (`\\`). Então `code: "23P01", message: "` com
 * aspas NUAS, a frase, o nome entre `\"` e o fechamento `", severity:` só
 * podem vir dos campos do próprio erro — um dado com a frase inteira entre
 * aspas aparece no `detail` como `\"…\"` e não casa (medido, e mantido vivo
 * pelo controle negativo do AC-020 em `spec-086-trava.db-spec.ts`).
 * Conferir só o `23P01` não bastaria: um EXCLUDE alheio tem o mesmo SQLSTATE.
 */
const EXCLUDE_DE_EMAIL_VIOLADO =
  /PostgresError \{ code: "23P01", message: "conflicting key value violates exclusion constraint \\"usuarios_email_gestao_excl\\"", severity: "ERROR"/;

/** Só acontece numa corrida que a trava já deveria ter serializado (D9). */
export const CONVITE_EM_EMISSAO = Object.freeze({
  statusCode: 409,
  code: 'CONVITE_EM_EMISSAO',
  message:
    'Outro convite para esta pessoa está sendo emitido agora. Tente de novo.',
});

const TRADUCOES: readonly {
  readonly modelo: string;
  readonly colunas: readonly string[];
  readonly corpo: object;
}[] = [
  {
    modelo: 'ConviteDeAcesso',
    colunas: ['usuario_id'],
    corpo: CONVITE_EM_EMISSAO,
  },
];

/**
 * Devolve **o que lançar**: a recusa traduzida, ou o próprio erro, intacto,
 * quando ele não é uma das duas violações da tabela. O uso é
 * `catch (erro) { throw traduzirViolacaoDeUnicidade(erro); }`.
 */
export function traduzirViolacaoDeUnicidade(erro: unknown): unknown {
  if (ehViolacaoDeEmail(erro)) {
    return new ConflictException(EMAIL_EM_USO);
  }
  if (
    !(erro instanceof Prisma.PrismaClientKnownRequestError) ||
    erro.code !== 'P2002'
  ) {
    return erro;
  }
  const meta = erro.meta as
    { modelName?: unknown; target?: unknown } | undefined;
  const alvo = meta?.target;
  if (!Array.isArray(alvo)) {
    return erro;
  }
  const traducao = TRADUCOES.find(
    (t) =>
      t.modelo === meta?.modelName &&
      t.colunas.length === alvo.length &&
      t.colunas.every((coluna, i) => alvo[i] === coluna),
  );
  return traducao ? new ConflictException(traducao.corpo) : erro;
}

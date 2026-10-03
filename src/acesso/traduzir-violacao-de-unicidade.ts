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
 * | `usuarios_email_key` (o e-mail já é de outra conta) | `409 EMAIL_EM_USO` |
 * | `convites_de_acesso_um_vivo_por_usuario` (dois convites vivos) | `409 CONVITE_EM_EMISSAO` |
 *
 * **Qualquer outra violação sobe sem tradução** e vira `500`: um `UNIQUE` que
 * ninguém esperava é defeito a aparecer, e não recusa a explicar por palpite.
 *
 * ## Por modelo E colunas, nunca só pelo código
 *
 * O `P2002` não traz o nome da constraint (achado DOR-083-R2-04), só o modelo
 * e as colunas. **Medido em 2026-10-03 contra o Postgres local, pela API de
 * modelo, dentro e fora de transação interativa** — e é o
 * `spec-083-corrida-do-professor.db-spec.ts` que mantém a medição viva:
 *
 * | constraint | `meta` |
 * |---|---|
 * | `usuarios_email_key` | `{modelName: 'Usuario', target: ['email']}` |
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
  message:
    'Este e-mail já pertence a outra conta. Uma pessoa não pode ter duas contas na plataforma (LIM-001).',
});

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
  { modelo: 'Usuario', colunas: ['email'], corpo: EMAIL_EM_USO },
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

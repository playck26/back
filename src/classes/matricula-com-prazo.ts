import type { Prisma } from '@prisma/client';
import { RESTO_DO_PRAZO } from '../common/lock/prazo-de-espera';

/**
 * SPEC-082/D2b e AC-018 — **o `INSERT` da matrícula, com o prazo dentro dele.**
 *
 * Substitui o `tx.turmaAluno.create` de `entrarNaTransacao` e de
 * `allocateStudent`: a API de modelo do Prisma não carrega o `WITH` que
 * recalcula o `lock_timeout` nem o `FOR KEY SHARE` explícito.
 *
 * - A linha do **aluno** (alvo da FK `aluno_id`) é travada em `FOR KEY SHARE`
 *   ANTES de gravar, com o prazo recalculado imediatamente antes dela: a
 *   checagem de FK do `INSERT` encontra a linha já travada pela própria
 *   transação e não espera com um valor antigo (achado 082-V3-01). A turma já
 *   é da transação, pelo `FOR UPDATE`.
 * - O retorno tem os **mesmos nomes e tipos** do `create` de hoje (`id`,
 *   `turmaId`, `alunoId`, `createdAt` como data), por alias — é o corpo HTTP
 *   dos dois endpoints.
 * - O comentário do começo é o **marcador fixo** por onde o dublê dos testes
 *   roteia esta instrução (regra DEF-VC031-02: pelo marcador, nunca pelo
 *   predicado).
 */
export const MARCADOR_DA_MATRICULA_COM_PRAZO = '/* matricula-com-prazo */';

export interface MatriculaGravada {
  id: string;
  turmaId: string;
  alunoId: string;
  createdAt: Date;
}

export async function inserirMatriculaComPrazo(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  turmaId: string,
  alunoId: string,
): Promise<MatriculaGravada> {
  const linhas = await tx.$queryRaw<
    MatriculaGravada[]
  >`/* matricula-com-prazo */
    WITH alvo AS MATERIALIZED (
      SELECT al.id
        FROM (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg) r,
             LATERAL (SELECT a2.id FROM alunos a2
                       WHERE a2.id = ${alunoId}::uuid AND r.cfg IS NOT NULL
                       FOR KEY SHARE) al)
    INSERT INTO turma_alunos (id, turma_id, aluno_id, created_at)
    SELECT gen_random_uuid(), ${turmaId}::uuid, alvo.id, now() FROM alvo
    RETURNING id, turma_id AS "turmaId", aluno_id AS "alunoId",
              created_at AS "createdAt"`;
  const gravada = linhas[0];
  if (!gravada) {
    // O aluno foi lido na mesma transação; sumir aqui é estado impossível, e
    // o erro precisa aparecer em vez de uma matrícula silenciosamente ausente.
    throw new Error(`matrícula não gravada: aluno ${alunoId} não encontrado`);
  }
  return gravada;
}

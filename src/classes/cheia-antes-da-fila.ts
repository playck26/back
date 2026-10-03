import type { Prisma } from '@prisma/client';

/**
 * SPEC-082/D5 (REQ-004) — **turma já cheia é recusada antes de entrar na fila
 * da trava**, em `entrar` e em `allocateStudent`. Uma ida, **fora** da
 * transação e sem trava nenhuma.
 *
 * **Ela só responde "cheia" quando a transação responderia a mesma coisa.** A
 * ordem das recusas é a mensagem (`motivoDeBloqueio`): quem já está na turma
 * recebe a matrícula que existe; quem não é aprovado, está em turma inativa,
 * no limite ou em outro nível ouve ISSO antes de ouvir que a turma está cheia.
 * Por isso a consulta repete, na mesma ordem lógica, cada condição que a
 * transação confere antes da capacidade — e, se qualquer uma delas falhar,
 * devolve `false` e deixa a transação decidir (com a mensagem certa).
 *
 * **A checagem de dentro da transação continua sendo a que vale** (AC-010): a
 * de fora só poupa espera. Turma com vaga aqui e cheia lá dentro recebe
 * `TURMA_CHEIA` da transação.
 *
 * `confirmar` fica de fora (REQ-004): a recusa dele precisa encerrar a linha da
 * fila dentro da transação (SPEC-064).
 */
export type QuemMatricula = 'aluno' | 'gestor';

export async function cheiaAntesDaFila(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  companyId: string,
  turmaId: string,
  alunoId: string,
  quem: QuemMatricula,
): Promise<boolean> {
  const linhas = await db.$queryRaw<{ cheia: boolean }[]>`
    SELECT (
        NOT EXISTS (SELECT 1 FROM turma_alunos ja
                     WHERE ja.turma_id = t.id AND ja.aluno_id = a.id)
        AND a.vinculo = 'aprovado'
        AND (${quem}::text = 'gestor' OR t.status = 'ativa')
        AND (${quem}::text = 'aluno' OR a.status = 'ativo')
        AND (${quem}::text = 'gestor'
             OR e.limite_turmas_por_aluno IS NULL
             OR (SELECT count(*) FROM turma_alunos minhas
                  WHERE minhas.aluno_id = a.id) < e.limite_turmas_por_aluno)
        AND t.nivel_id IS NOT DISTINCT FROM COALESCE(
              a.nivel_id,
              (SELECT n.id FROM niveis n
                WHERE n.company_id = t.company_id
                ORDER BY n.ordem, n.created_at, n.id LIMIT 1))
        AND (SELECT count(*) FROM turma_alunos z WHERE z.turma_id = t.id)
            >= t.capacidade
      ) AS cheia
      FROM turmas t
      JOIN alunos a ON a.id = ${alunoId}::uuid AND a.company_id = t.company_id
      JOIN empresas e ON e.id = t.company_id
     WHERE t.id = ${turmaId}::uuid AND t.company_id = ${companyId}::uuid`;
  return linhas[0]?.cheia === true;
}

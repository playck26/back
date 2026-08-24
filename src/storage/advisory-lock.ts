import { ordenarChavesParaLock, StorageLockKey } from './storage-lock-key';

/**
 * SPEC-017/TASK-005 — o lock por chave de objeto (INV-039/042/046).
 *
 * **A raiz de lock é o OBJETO, não o recurso de domínio.** Foi o erro da
 * minha análise original, derrubado na 3ª rodada de validação da spec: eu
 * procurei a raiz na quadra, no aluno, na empresa — mas o recurso disputado
 * é o objeto no bucket. `PutObject` + gravação no banco, e reconferência +
 * `DeleteObject`, disputam a **chave**.
 *
 * ---
 *
 * **`pg_try_advisory_XACT_lock`, e não `pg_try_advisory_lock`.** A spec diz
 * `pg_try_advisory_lock`; esta é uma divergência deliberada, declarada no
 * harness da TASK-005 para a validação julgar.
 *
 * A razão é o pool de conexões. Lock de **sessão** vive até `unlock` ou até
 * a conexão morrer — e numa conexão de pool, um caminho de exceção que pule
 * o `unlock` **envenena aquela conexão para sempre**: ela volta para o pool
 * segurando um lock que ninguém mais consegue soltar, e a próxima requisição
 * que precisar daquela chave trava sem explicação. Lock de **transação**
 * solta sozinho no commit e no rollback, inclusive no rollback que ninguém
 * escreveu.
 *
 * O que a spec exige de verdade continua valendo: é `try` (INV-046, o worker
 * **nunca** espera), e é por chave (INV-039).
 */

/** O que o `$transaction` do Prisma entrega — só o que usamos daqui. */
export interface ClienteComSql {
  // Sem genérico de propósito: uma função concreta não satisfaz uma
  // assinatura genérica, e o `tx` do Prisma e os dublês de teste precisam
  // caber no mesmo tipo.
  $queryRaw(
    query: TemplateStringsArray,
    ...valores: unknown[]
  ): Promise<unknown>;
}

/**
 * Tenta tomar o lock de uma chave. **Não espera**: devolve `false` na hora
 * se outra transação estiver com ela.
 */
export async function tentarLockDeChave(
  tx: ClienteComSql,
  key: string,
): Promise<boolean> {
  const lockId = StorageLockKey.fromObjectKey(key);
  const linhas = (await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(${lockId}::bigint) AS tomou
  `) as { tomou: boolean }[] | undefined;
  // `=== true` e não coerção: resposta que não dá para interpretar não pode
  // virar "tomou o lock".
  return linhas?.[0]?.tomou === true;
}

/**
 * Toma o lock de várias chaves, **em ordem lexicográfica** (AC-021), e só
 * roda `acao` se conseguir todas.
 *
 * Ordem fixa é o que impede ciclo entre dois caminhos que precisam das
 * mesmas duas chaves. E como é `try`, falhar em uma no meio não deixa
 * ninguém esperando: a transação inteira desiste e os locks já tomados
 * soltam no rollback.
 *
 * **Chamar isto DEPOIS de qualquer lock de linha** (INV-042): domínio
 * primeiro, advisory por chave depois, e nunca ao contrário.
 */
export async function comLockDeChaves<T>(
  tx: ClienteComSql,
  keys: readonly string[],
  acao: () => Promise<T>,
): Promise<T | null> {
  for (const key of ordenarChavesParaLock(keys)) {
    if (!(await tentarLockDeChave(tx, key))) {
      return null;
    }
  }
  return acao();
}

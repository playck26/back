import { createHash } from 'node:crypto';

/**
 * SPEC-017/TASK-005 — o `bigint` do advisory lock, e **este arquivo é a
 * única forma de calculá-lo** (INV-043/AC-020).
 *
 * **Colisão aqui é inofensiva para correção**: duas chaves diferentes se
 * serializam à toa, perde-se paralelismo, não se perde exatidão.
 *
 * **O risco real é o inverso**, e foi o validador quem nomeou: dois trechos
 * calculando `bigint` **diferente para a mesma string**, e achando que
 * travaram a mesma coisa. Aí não há lock nenhum, e o defeito é invisível —
 * tudo passa, até o dia em que um `DELETE` roda no meio de um `PUT`.
 *
 * Por isso o algoritmo é fixo e escrito por extenso: **sha256 do UTF-8 da
 * chave, os 8 primeiros bytes, big-endian, com sinal.** Nenhuma dessas
 * quatro escolhas pode mudar sem quebrar todo lock já tomado, e nenhuma
 * delas pode ser reimplementada em outro lugar.
 *
 * Com sinal porque `pg_advisory_lock` recebe `bigint` do Postgres, que é
 * assinado: mandar um valor não-assinado acima de 2^63-1 estoura, e o driver
 * ou o banco reclamaria — ou pior, converteria em silêncio.
 */
export const StorageLockKey = {
  fromObjectKey(key: string): bigint {
    const digest = createHash('sha256').update(key, 'utf8').digest();
    return digest.readBigInt64BE(0);
  },
};

/**
 * AC-021 — precisando de mais de uma chave, os locks são tomados em **ordem
 * lexicográfica da chave**.
 *
 * Ordem por chave e não pelo `bigint`: se um dia o algoritmo mudar, a ordem
 * continua a mesma nos dois lados do grafo. Ordenar pelo número tornaria a
 * ordem de aquisição dependente do hash, e duas versões do código
 * conviveriam com ordens diferentes durante um deploy — que é exatamente
 * quando um deadlock apareceria.
 */
export function ordenarChavesParaLock(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

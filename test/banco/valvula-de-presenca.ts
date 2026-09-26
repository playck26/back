/**
 * SPEC-076/D7 — **como uma fixture grava chamada HUMANA LEGADA.**
 *
 * A D10 põe gatilhos que recusam presença com autor humano e cabeçalho
 * `completa` de origem humana (`23514`). É a regra do produto — ninguém grava
 * presença à mão —, e ela vale para qualquer caminho, inclusive `INSERT` cru
 * numa fixture.
 *
 * Mas o banco de produção **tem** chamadas humanas antigas, e as provas de
 * leitura (`legada`, `CHAMADA_COM_PRESENCA`, a ratificada da D9) precisam
 * delas. Elas entram pela **mesma válvula da SPEC-032**: o GUC de transação
 * e a role `playck_test_cleanup`, que só existe no banco de testes. Um lugar
 * que sabe fazer certo, em vez de N fixtures abrindo a válvula cada uma.
 */
import type { PrismaClient } from '@prisma/client';

export async function comValvula(
  db: PrismaClient,
  sqls: readonly string[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE playck_test_cleanup`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('playck.limpeza_append_only', 'on', true)`,
    );
    for (const sql of sqls) await tx.$executeRawUnsafe(sql);
  });
}

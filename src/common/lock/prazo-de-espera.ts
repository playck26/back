import { Prisma } from '@prisma/client';

/**
 * SPEC-082/D2 e D2b — **o prazo de espera da matrícula é da matrícula
 * inteira** (I3, I7): 2 s contados desde o primeiro pedido de vez.
 *
 * O prazo é **absoluto e mora no servidor** — a instrução inicial grava
 * `clock_timestamp() + 2 s` na variável de transação `playck.prazo`, e cada
 * aquisição seguinte recalcula o `lock_timeout` pelo relógio do BANCO,
 * imediatamente antes dela. Nenhuma conta depende do relógio do Back.
 *
 * **Sem ida a mais:** o recálculo vai dentro da instrução que trava (num
 * `WITH … MATERIALIZED` ou num `LATERAL` que depende da linha). A pré-prova da
 * spec mediu por que a dependência importa: um `LATERAL` que não depende da
 * linha é avaliado uma vez só (3.513 ms contra 2.030 ms).
 *
 * **Nenhum import do Nest e nenhum alias de caminho**: o seed importa
 * `nivel-efetivo.ts`, que importa este arquivo, por `ts-node` sem
 * `tsconfig-paths`.
 */

/** I3/I7 — a espera total da matrícula. */
export const PRAZO_DA_MATRICULA_MS = 2_000;

/**
 * D3 — o tempo-limite das três transações leitoras: 2 s de espera total +
 * teto de idas × 250 ms + 1 s de folga. O maior teto (20, `confirmar`) dá
 * exatamente 8.000 ms; o AC-014 amarra esta conta aos tetos.
 */
export const TIMEOUT_DA_MATRICULA_MS = 8_000;

/** Latência de orçamento por ida usada na conta do D3. */
export const LATENCIA_DE_ORCAMENTO_MS = 250;

/** Folga da conta do D3. */
export const FOLGA_DO_TIMEOUT_MS = 1_000;

/** O nome da variável de transação — e o marcador que o gate do AC-017 procura. */
export const MARCADOR_DO_PRAZO = 'playck.prazo';

/**
 * O resto do prazo, em ms, como texto para `set_config('lock_timeout', …)`.
 *
 * - **piso de 1 ms**: `lock_timeout = 0` DESLIGA o teto no Postgres;
 * - **sem prazo na transação** (os caminhos que não são matrícula e usam as
 *   mesmas instruções — o aviso ao gestor, a fila de aula), mantém o
 *   `lock_timeout` vigente: a instrução não muda o comportamento deles.
 *   `NULLIF(…, '')` porque uma variável customizada já usada na sessão volta
 *   como texto vazio, e não nulo, depois que a transação local termina.
 */
export const RESTO_DO_PRAZO = Prisma.raw(
  `(CASE WHEN NULLIF(current_setting('${MARCADOR_DO_PRAZO}', true), '') IS NULL
         THEN current_setting('lock_timeout')
         ELSE greatest(1, floor(extract(epoch FROM (
                current_setting('${MARCADOR_DO_PRAZO}')::timestamptz
                - clock_timestamp())) * 1000))::int::text || 'ms'
    END)`,
);

/**
 * D2b — o CTE que recalcula o `lock_timeout` **antes** de uma aquisição de uma
 * linha só. Quem usa escreve `WITH ${CTE_DO_PRAZO} SELECT … WHERE … AND EXISTS
 * (SELECT 1 FROM prazo_r) FOR UPDATE`: o `EXISTS` é o que obriga o CTE a rodar
 * antes de a linha ser devolvida (e travada).
 */
export const CTE_DO_PRAZO = Prisma.sql`prazo_r AS MATERIALIZED (
  SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg)`;

/** O predicado que amarra a instrução ao CTE do prazo. */
export const DEPOIS_DO_PRAZO = Prisma.raw(`EXISTS (SELECT 1 FROM prazo_r)`);

/**
 * A instrução inicial da matrícula (D2): grava o prazo absoluto, recalcula,
 * toma a trava do clube em modo **compartilhado**, recalcula de novo e toma a
 * trava do **aluno** em modo exclusivo. Uma ida.
 *
 * Cada `LATERAL` depende do anterior — é isso que obriga a avaliação na ordem
 * e uma vez por passo. `b.c IS NULL OR b.c IS NOT NULL` porque as funções de
 * advisory devolvem `void`: a condição é sempre verdadeira, e existe só para
 * criar a dependência.
 */
export function instrucaoInicialDaMatricula(
  chaveDoClube: bigint,
  chaveDoAluno: bigint,
): Prisma.Sql {
  return Prisma.sql`
    SELECT 1 AS ok
      FROM (SELECT set_config('${Prisma.raw(MARCADOR_DO_PRAZO)}',
                     (clock_timestamp()
                      + ${PRAZO_DA_MATRICULA_MS}::int * interval '1 millisecond')::text,
                     true) AS p) a,
           LATERAL (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg
                     WHERE a.p IS NOT NULL) r1,
           LATERAL (SELECT pg_advisory_xact_lock_shared(${chaveDoClube}::bigint) AS c
                     WHERE r1.cfg IS NOT NULL) b,
           LATERAL (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg
                     WHERE b.c IS NULL OR b.c IS NOT NULL) r2,
           LATERAL (SELECT pg_advisory_xact_lock(${chaveDoAluno}::bigint) AS l
                     WHERE r2.cfg IS NOT NULL) c`;
}

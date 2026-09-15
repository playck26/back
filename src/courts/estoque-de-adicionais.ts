import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { BlocoDeReserva } from './slots.util';

type Cliente = PrismaService | Prisma.TransactionClient;

/**
 * SPEC-054/D4 — **a ordem em que os adicionais são travados: por `id`, sem
 * repetição.**
 *
 * É a "função de travas" que a prova determinística da ordem exercita: duas
 * transações que pedem `[A, B]` e `[B, A]` recebem daqui a MESMA sequência, e por
 * isso nunca seguram cada uma o que a outra quer. A comparação é do `uuid` em
 * texto minúsculo — o mesmo que o `ORDER BY` do Postgres faz sobre `uuid`, porque
 * os dois comparam os bytes na ordem.
 */
export function ordemDeTravaDosAdicionais(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/**
 * **Nível 2b** da ordem global (DATA_MODEL.md): `FOR UPDATE` em cada adicional,
 * **uma instrução por linha, na ordem de `ordemDeTravaDosAdicionais`**.
 *
 * Uma instrução só com `ORDER BY id` também travaria em ordem — mas a ordem
 * ficaria implícita no plano de execução, e a prova da D4 não teria como pôr uma
 * barreira entre a primeira trava e a segunda. Uma por vez é o que torna a ordem
 * **observável**.
 *
 * **A correção não depende desta trava** — a trigger `adicional_cabe_no_estoque`
 * trava o mesmo adicional. Esta existe para dar ORDEM: sem ela, dois pedidos com
 * os adicionais em ordens opostas, ou uma criação contra um movimento, fecham
 * ciclo (`40P01`). O preço lido aqui é o que a reserva congela (D6).
 */
export async function travarAdicionais(
  tx: Prisma.TransactionClient,
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, { preco: Prisma.Decimal; ativo: boolean }>> {
  const travados = new Map<string, { preco: Prisma.Decimal; ativo: boolean }>();
  for (const id of ordemDeTravaDosAdicionais(ids)) {
    const [linha] = await tx.$queryRaw<
      { preco: Prisma.Decimal; ativo: boolean }[]
    >`
      SELECT preco, ativo FROM adicionais
       WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
         FOR UPDATE`;
    if (linha) {
      travados.set(id, linha);
    }
  }
  return travados;
}

/**
 * **A conta da trigger, do lado de fora:** `estoque` − soma das quantidades dos
 * itens em ocupações não canceladas cujo intervalo se sobrepõe ao do bloco; o
 * MENOR valor entre os blocos; nunca negativo (o estoque pode ter sido baixado
 * abaixo do reservado, D13).
 *
 * Serve a leitura da tela (`GET /adicionais/disponiveis`) e o `disponivel` da
 * recusa de estoque, lido **depois** do `ROLLBACK` da criação (D7) — as duas
 * respostas precisam ser a mesma conta (AC-018).
 */
export async function saldosDosAdicionaisNoPedido(
  cliente: Cliente,
  companyId: string,
  adicionalIds: readonly string[],
  data: string,
  blocos: readonly BlocoDeReserva[],
): Promise<Map<string, number>> {
  const saldos = new Map<string, number>();
  const ids = [...adicionalIds];
  for (const bloco of blocos) {
    const linhas = await cliente.$queryRaw<
      { id: string; disponivel: number }[]
    >`
      SELECT a.id::text AS id,
             (a.estoque - coalesce((
                SELECT sum(i.quantidade)
                  FROM adicionais_da_ocupacao i
                  JOIN ocupacoes_quadra o
                    ON o.company_id = i.company_id AND o.id = i.ocupacao_id
                 WHERE i.adicional_id = a.id
                   AND o.status_pagamento <> 'cancelado'
                   AND tsrange(o.data + o.hora_inicio, o.data + o.hora_fim)
                    && tsrange(${data}::date + ${bloco.horaInicio}::time,
                               ${data}::date + ${bloco.horaFim}::time)
             ), 0))::int AS disponivel
        FROM adicionais a
       WHERE a.company_id = ${companyId}::uuid
         AND a.id = ANY(${ids}::uuid[])`;
    for (const { id, disponivel } of linhas) {
      const atual = saldos.get(id);
      const saldo = Math.max(0, disponivel);
      saldos.set(id, atual === undefined ? saldo : Math.min(atual, saldo));
    }
  }
  return saldos;
}

export interface ItemParaInserir {
  adicionalId: string;
  quantidade: number;
  valorUnitario: Prisma.Decimal;
}

/**
 * Os itens de UMA ocupação, **na transação que a criou** (D5).
 *
 * **Por SQL cru, e não `adicionalDaOcupacao.create`:** com o schema que a
 * introspecção produz (`@default(AVULSO)` na coluna gerada), o Prisma envia o
 * valor, e o Postgres recusa escrever em coluna gerada — `428C9`, medido. As
 * recusas das triggers chegam então como `P2010` com `meta.code`, que
 * `sqlstateDoErro` lê.
 *
 * Um `INSERT` por item, em ordem de `adicionalId`: a trigger de estoque trava o
 * adicional de cada linha, e a ordem é a mesma da trava 2b que a transação já
 * detém — ela só RETOMA o que já tem.
 */
export async function inserirItensDaOcupacao(
  tx: Prisma.TransactionClient,
  companyId: string,
  ocupacaoId: string,
  itens: readonly ItemParaInserir[],
): Promise<void> {
  const ordenados = [...itens].sort((a, b) =>
    a.adicionalId < b.adicionalId ? -1 : 1,
  );
  for (const item of ordenados) {
    await tx.$executeRaw`
      INSERT INTO adicionais_da_ocupacao
        (id, company_id, ocupacao_id, adicional_id, quantidade, valor_unitario)
      VALUES (${randomUUID()}::uuid, ${companyId}::uuid, ${ocupacaoId}::uuid,
              ${item.adicionalId}::uuid, ${item.quantidade}, ${item.valorUnitario})`;
  }
}

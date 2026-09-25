import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** SPEC-074/D7 — o padrão, **e o teto**, de slots examinados por ciclo. */
export const LOTE_DA_PRE_RESERVA = 200;

/**
 * SPEC-074/D7 — **o tamanho do lote, lido de `PRE_RESERVA_LOTE`.**
 *
 * **Inteiro de 1 a 200, só dígitos decimais**, e qualquer outro valor cai no
 * padrão com `warn`. Os dois limites têm motivo:
 *
 * - **abaixo de 1**: lote `0` examinaria nada — um interruptor disfarçado, que
 *   o `PRE_RESERVA_INTERVALO_MS=0` já é;
 * - **acima de 200**: desfaria o orçamento que a D7, o REQ-007 e a LIM-074b
 *   prometem — e um lote enorme desliga na prática, por duração, memória e
 *   transações (B-01 da 7ª rodada). **A variável existe para DESCER** (a
 *   AC-030 usa 1), não para subir.
 *
 * **Só dígitos, e não `Number()`:** `Number('1e2')` é 100, `Number('0x10')` é
 * 16 e `Number(' 150 ')` é 150 — três erros de digitação que seriam aceitos
 * em silêncio.
 *
 * Ausente é o padrão **sem** `warn`: é o estado normal de produção.
 */
export function loteDaConfiguracao(valor: string | undefined): {
  lote: number;
  invalido: boolean;
} {
  if (valor === undefined) {
    return { lote: LOTE_DA_PRE_RESERVA, invalido: false };
  }
  if (!/^[0-9]+$/.test(valor)) {
    return { lote: LOTE_DA_PRE_RESERVA, invalido: true };
  }
  const n = Number(valor);
  if (n < 1 || n > LOTE_DA_PRE_RESERVA) {
    return { lote: LOTE_DA_PRE_RESERVA, invalido: true };
  }
  return { lote: n, invalido: false };
}

/** Um slot do lote: o horário exato que alguém espera (D1). */
export interface SlotDoLote {
  companyId: string;
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
}

export interface Lote {
  /** Slots que passam em 1 a 3 da D5, **contados antes do `LIMIT`** —
   *  inclusive os que o expediente vai reprovar no passo 4. */
  candidatos: number;
  /** Slots **distintos** com pedido vivo — ocupados ou não. */
  slotsPendentes: number;
  lote: SlotDoLote[];
}

/**
 * SPEC-074/D7, passo 3 — **a seleção do lote, e a costura dos testes.**
 *
 * ## Por que é uma classe própria
 *
 * Em produção ela só seleciona. A AC-027 a constrói com lote 1 ou 2, e a
 * AC-029 a **envolve** — faz a seleção de verdade e, antes de devolvê-la,
 * cancela um pedido em outra conexão. Assim `executarCiclo()` não carrega
 * parâmetro que só a suíte usa (R-02 da 3ª rodada). **E quem garante que
 * produção monta ESTA classe, e não outra sob o mesmo token, é a AC-030** — o
 * boot sozinho não garante (B-01 da 5ª rodada).
 *
 * ## "Vagou" é a MESMA definição da grade (D5)
 *
 * 1. `inicio_em > now()`; 2. quadra `ativa`; 3. nenhuma ocupação não
 * cancelada com conflito semiaberto — **no SQL**. O 4, o expediente, é do
 * varredor, no código, pela mesma resolução da grade.
 *
 * ## O rodízio
 *
 * A chave é `min(coalesce(verificada_em, criada_em))`, e **não** `verificada_em
 * NULLS FIRST` (que deixava todo pedido novo furar a fila, achado da 2ª
 * rodada), nem `max` (que deixava pedido novo empurrar o slot antigo, B-02 da
 * 2ª). Os desempates depois da chave só ordenam chaves IGUAIS: existem para a
 * ordem ser determinística, não justa.
 *
 * ## As duas contagens são do MESMO instante
 *
 * Uma transação `REPEATABLE READ`, só de leitura, para as duas consultas: o
 * `slotsPendentes` não pode contar um mundo e o `candidatos` outro.
 */
@Injectable()
export class SeletorDoLote {
  private readonly logger = new Logger(SeletorDoLote.name);
  /** Lido UMA vez, na construção, como o agendador lê o intervalo. */
  readonly tamanho: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const { lote, invalido } = loteDaConfiguracao(
      config.get<string>('PRE_RESERVA_LOTE'),
    );
    if (invalido) {
      this.logger.warn(
        `PRE_RESERVA_LOTE inválido — usando ${LOTE_DA_PRE_RESERVA}. Aceita inteiro de 1 a ${LOTE_DA_PRE_RESERVA}, só dígitos.`,
      );
    }
    this.tamanho = lote;
  }

  async selecionar(): Promise<Lote> {
    return this.prisma.$transaction(
      async (tx) => {
        const [contagem] = await tx.$queryRaw<
          { candidatos: number; pendentes: number }[]
        >`
          WITH slots AS (
            SELECT p.company_id, p.quadra_id, p.data, p.hora_inicio, p.hora_fim
              FROM pre_reservas p
             WHERE p.estado = 'aguardando' AND p.inicio_em > now()
             GROUP BY p.company_id, p.quadra_id, p.data, p.hora_inicio, p.hora_fim
          )
          SELECT
            (SELECT count(*) FROM slots)::int AS pendentes,
            (SELECT count(*)
               FROM slots s
               JOIN quadras q
                 ON q.company_id = s.company_id AND q.id = s.quadra_id
                AND q.status = 'ativa'
              WHERE NOT EXISTS (
                SELECT 1 FROM ocupacoes_quadra o
                 WHERE o.company_id = s.company_id
                   AND o.quadra_id = s.quadra_id
                   AND o.data = s.data
                   AND o.status_pagamento <> 'cancelado'
                   AND o.hora_inicio < s.hora_fim
                   AND o.hora_fim > s.hora_inicio))::int AS candidatos`;

        const lote = await tx.$queryRaw<
          {
            company_id: string;
            quadra_id: string;
            data: Date;
            hora_inicio: Date;
            hora_fim: Date;
          }[]
        >`
          SELECT p.company_id, p.quadra_id, p.data, p.hora_inicio, p.hora_fim
            FROM pre_reservas p
            JOIN quadras q
              ON q.company_id = p.company_id AND q.id = p.quadra_id
             AND q.status = 'ativa'
           WHERE p.estado = 'aguardando'
             AND p.inicio_em > now()
             AND NOT EXISTS (
               SELECT 1 FROM ocupacoes_quadra o
                WHERE o.company_id = p.company_id
                  AND o.quadra_id = p.quadra_id
                  AND o.data = p.data
                  AND o.status_pagamento <> 'cancelado'
                  AND o.hora_inicio < p.hora_fim
                  AND o.hora_fim > p.hora_inicio)
           GROUP BY p.company_id, p.quadra_id, p.data, p.hora_inicio, p.hora_fim
           ORDER BY min(coalesce(p.verificada_em, p.criada_em)),
                    min(p.inicio_em),
                    p.quadra_id, p.data, p.hora_inicio
           LIMIT ${this.tamanho}`;

        return {
          candidatos: contagem.candidatos,
          slotsPendentes: contagem.pendentes,
          lote: lote.map((s) => ({
            companyId: s.company_id,
            quadraId: s.quadra_id,
            data: s.data,
            horaInicio: s.hora_inicio,
            horaFim: s.hora_fim,
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

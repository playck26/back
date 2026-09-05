import type { Prisma } from '@prisma/client';
import {
  agoraNoFusoDoClube,
  horaDeMinutos,
  minutosDaHora,
} from '../courts/date-time.util';
import type { Antecedencia } from '../company-settings/prazo-de-cancelamento';

/**
 * SPEC-031/D15 — **a ocorrência relevante é a EM ANDAMENTO, se houver; senão,
 * a próxima.**
 *
 * ## Por que não é "a próxima ocorrência"
 *
 * A v2 da spec dizia isso e não definia. Lido como *estritamente futura*, o
 * cenário 19h–20h às 19h05 pegaria a aula da **semana seguinte**: o prazo
 * daria folga de dias e o aluno sairia da turma **durante a própria aula**.
 *
 * O corte é pelo `hora_fim`, não pelo `hora_inicio` — é o que faz a aula em
 * andamento vencer a da semana que vem. Achada a ocorrência, a antecedência é
 * `início − agora`, que fica **negativa** durante a aula e cai no
 * `minutos <= 0` de `podeCancelar`. As duas metades se encaixam; antes, a
 * segunda nunca era alcançada.
 *
 * ## NÃO existe soma de `date` com `time` aqui, e isso é o mecanismo
 *
 * A v3 escrevia `(data + hora_fim) >= $2`. Medido contra o DEV, na sessão que
 * o Prisma de fato abre:
 *
 * ```
 * {"sessao_do_prisma":"GMT","tipo_da_soma":"timestamp without time zone",
 *  "relevante_pela_sessao":false,"relevante_em_brt":true}
 * ```
 *
 * `date + time` produz `timestamp **without** time zone`; comparado com um
 * `timestamptz`, o Postgres interpreta o primeiro no `TimeZone` **da sessão**
 * — e a sessão é `GMT`. Aula das 19h às 20h BRT, agora 17h30 BRT (= 20h30Z):
 * o banco lê o fim como 20h **UTC**, conclui que a aula terminou e descarta a
 * ocorrência — **2h30 antes de ela sequer começar**.
 *
 * É a quinta aparição da família DEF-020/INV-091 neste projeto. Por isso o
 * mecanismo não é "lembrar do fuso": é **comparar campos já normalizados**,
 * `data` contra `data` e `hora` contra `hora`. O gate de fuso do CI não
 * pegaria — ele procura `getUTCFullYear()` (INV-069), e nenhuma soma de tipos
 * SQL se parece com isso.
 */
export async function ocorrenciaRelevante(
  tx: Prisma.TransactionClient,
  companyId: string,
  turmaId: string,
  agora: Date,
): Promise<Antecedencia> {
  const agoraLocal = agoraNoFusoDoClube(agora);

  const ocorrencia = await tx.ocupacaoQuadra.findFirst({
    where: {
      companyId,
      origemTurmaId: turmaId,
      origemTipo: 'TURMA',
      statusPagamento: { not: 'cancelado' },
      OR: [
        // dias à frente
        { data: { gt: agoraLocal.dia } },
        // hoje, e ainda não terminou
        {
          data: agoraLocal.dia,
          horaFim: { gte: horaDeMinutos(agoraLocal.minutos) },
        },
      ],
    },
    orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    select: { id: true, data: true, horaInicio: true, horaFim: true },
  });

  if (!ocorrencia) return { tipo: 'SEM_OCORRENCIA' };

  // A antecedência é sobre o INÍCIO — o `hora_fim` acima serviu só para
  // escolher QUAL ocorrência. Durante a aula isto é negativo, de propósito.
  const diaEmMinutos =
    (ocorrencia.data.getTime() - agoraLocal.dia.getTime()) / 60_000;
  const minutos =
    diaEmMinutos + minutosDaHora(ocorrencia.horaInicio) - agoraLocal.minutos;

  return { tipo: 'MINUTOS', minutos };
}

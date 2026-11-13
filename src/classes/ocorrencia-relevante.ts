import type { Prisma } from '@prisma/client';
import {
  agoraNoFusoDoClube,
  horaDeMinutos,
  minutosDaHora,
} from '../courts/date-time.util';
import type {
  Antecedencia,
  PrazoDeCancelamento,
} from '../company-settings/prazo-de-cancelamento';

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
/**
 * A antecedência até um instante `data` + `horaInicio`, em minutos.
 *
 * Exportada porque **dois caminhos precisam da mesma conta**: a ocorrência de
 * turma (aqui) e a reserva avulsa (`cancelBooking`). Duplicá-la seria duplicar
 * também a chance de somar `date` com `time` num dos dois — ver o bloco acima.
 *
 * Fica **negativa** depois do início, e é isso que faz `podeCancelar` recusar.
 */
export function antecedenciaEmMinutos(
  data: Date,
  horaInicio: Date,
  agora: Date,
): number {
  const agoraLocal = agoraNoFusoDoClube(agora);
  const diaEmMinutos = (data.getTime() - agoraLocal.dia.getTime()) / 60_000;
  return diaEmMinutos + minutosDaHora(horaInicio) - agoraLocal.minutos;
}

/**
 * DEF-041 — **o `where` das ocorrências que o aluno ainda pode marcar, pela
 * hora.**
 *
 * A lista de reposição filtrava só `data >= hoje`. Às 18h38 ela oferecia a
 * aula das 7h de hoje, e o `POST` recusava com "Esta aula já começou" — a
 * tela oferecendo o que o servidor recusa, que a SPEC-042 proibiu para a
 * reserva avulsa e que a SPEC-046 (AC-004, "ocorrências **futuras**") já
 * proibia aqui.
 *
 * ## É a mesma conta do `POST`, e não uma parecida
 *
 * `marcarNaTransacao` recusa por `podeCancelar(prazo, antecedenciaEmMinutos)`:
 * sem prazo, aceita `minutos > 0`; com prazo, `minutos >= horas * 60`. Em
 * minutos inteiros as duas são `minutos >= alvo`, com alvo `1` ou
 * `horas * 60`. Cortar só o que já começou deixaria, num clube com prazo de
 * 2h, a aula das 19h oferecida às 18h38 e recusada com "exige 2h de
 * antecedência" — o mesmo defeito, uma hora adiante.
 *
 * O alvo pode cair num dia seguinte (prazo de 2h às 23h, ou de 48h), e por
 * isso o corte é um **dia** e uma **hora**, em duas pernas — a forma de
 * `recorteTemporal`, e sem somar `date` com `time` (bloco no topo).
 *
 * Vai no `where`, antes do `take: 200` de quem chama: cortado depois, as
 * aulas que já passaram ocupariam o limite (o motivo da INV-075b).
 */
export function aindaSePodeMarcar(
  prazo: PrazoDeCancelamento,
  agora: Date,
): Prisma.OcupacaoQuadraWhereInput {
  const agoraLocal = agoraNoFusoDoClube(agora);
  let antecedenciaMinima: number;
  switch (prazo.regra) {
    case 'SEM_PRAZO':
      antecedenciaMinima = 1;
      break;
    case 'HORAS':
      antecedenciaMinima = prazo.horas * 60;
      break;
    default: {
      const _exaustivo: never = prazo;
      return _exaustivo;
    }
  }
  const alvo = agoraLocal.minutos + antecedenciaMinima;
  const diaDoCorte = new Date(
    agoraLocal.dia.getTime() + Math.floor(alvo / 1440) * 86_400_000,
  );
  return {
    OR: [
      { data: { gt: diaDoCorte } },
      { data: diaDoCorte, horaInicio: { gte: horaDeMinutos(alvo % 1440) } },
    ],
  };
}

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
  return {
    tipo: 'MINUTOS',
    minutos: antecedenciaEmMinutos(
      ocorrencia.data,
      ocorrencia.horaInicio,
      agora,
    ),
  };
}

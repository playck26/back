import type { CompletudeChamada } from '@prisma/client';
import { aulaJaComecou, aulaJaTerminou } from '../courts/date-time.util';

/**
 * SPEC-030:TASK-002 — **o estado da chamada, num lugar só** (INV-030b).
 *
 * ## Por que este arquivo existe
 *
 * A mesma pergunta — *"esta aula já teve chamada?"* — era respondida em
 * **quatro** lugares, por **três** regras diferentes:
 *
 * | Onde | Como decidia |
 * |---|---|
 * | `agenda-do-professor.service.ts` (calendário) | `completude === 'completa'` |
 * | `presenca.service.ts` (ocorrências da turma, professor) | `_count.presencas > 0` |
 * | `presenca.service.ts` (histórico da turma, gestor) | `presencas.length > 0` |
 * | `frequencia.service.ts` (relatório) | lia **as duas** e expunha separado |
 *
 * O registro do projeto dizia que eram duas. Eram quatro, e a quarta só
 * apareceu quando a SPEC-030 trouxe o gestor para o escopo.
 *
 * **A divergência não era teórica:** uma ocorrência com cabeçalho e ZERO
 * presenças saía `feita` pelo calendário e `pendente` pela lista da turma.
 * Os dois usavam o mesmo vocabulário na resposta, o que tornava a diferença
 * invisível para quem lia a API.
 *
 * ## O que decidiu a regra vencedora
 *
 * **O cabeçalho manda, não a contagem de presenças.** `chamadas` é a
 * declaração explícita de que o professor registrou a aula; `presencas` é
 * consequência. Uma turma onde todo mundo faltou tem cabeçalho e zero
 * presenças — e a chamada **foi feita**. Contar presenças chamava isso de
 * pendente e mandava o professor lançar de novo.
 *
 * É também a única regra que sobrevive à SPEC-030: `nao_houve` é um
 * cabeçalho sem nenhuma presença, por definição.
 *
 * ## A ordem das perguntas importa
 *
 * `cancelada` vem antes de tudo porque uma aula cancelada não é pendência de
 * ninguém, tenha cabeçalho ou não. O cabeçalho vem antes do relógio porque,
 * se a chamada existe, o horário deixou de importar (SPEC-027).
 */
export type EstadoDaChamada =
  /** A ocorrência foi cancelada. Não é pendência, e não recebe chamada. */
  | 'cancelada'
  /** Ainda não começou: não oferece chamada, sem ponto (SPEC-027). */
  | 'futura'
  /** Entre início e fim: oferece chamada, **sem** vermelho (SPEC-027). */
  | 'em_andamento'
  /** Já terminou e ninguém registrou: é o vermelho do calendário. */
  | 'pendente'
  /** Cabeçalho com `completude = completa`. */
  | 'feita'
  /** Cabeçalho de antes da SPEC-015, com `completude = desconhecida`. */
  | 'legada'
  /** SPEC-030: alguém declarou que a aula não aconteceu. Sem vermelho. */
  | 'nao_houve';

/**
 * O que o resolvedor precisa saber. Deliberadamente **não é** uma linha do
 * Prisma: os quatro consumidores fazem `select`s diferentes, e amarrar a
 * função ao formato de um deles obrigaria os outros três a carregar campo
 * que não usam.
 */
export interface OcorrenciaParaEstado {
  /** `statusPagamento === 'cancelado'`, resolvido pelo chamador. */
  cancelada: boolean;
  /**
   * A `completude` do cabeçalho, ou `null`/`undefined` quando não há
   * cabeçalho. **Ausência é informação**: é o que separa `pendente` de
   * `feita`.
   */
  completude: CompletudeChamada | null | undefined;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
}

/**
 * Resolve o estado da chamada de uma ocorrência.
 *
 * `agora` é injetável porque **toda prova que depende do relógio vira
 * sorteio se não for** — quatro defeitos em dois dias vieram daí
 * (DEF-020/021 e as duas quedas de CI de 2026-08-30). A conta a fazer não é
 * *"isto está certo?"*, é *"isto muda de resposta dependendo de quando
 * roda?"*.
 */
export function resolverEstadoDaChamada(
  o: OcorrenciaParaEstado,
  agora: Date = new Date(),
): EstadoDaChamada {
  if (o.cancelada) return 'cancelada';

  // O cabeçalho manda. Se ele existe, o relógio não importa mais.
  if (o.completude) {
    switch (o.completude) {
      case 'completa':
        return 'feita';
      case 'nao_houve':
        return 'nao_houve';
      case 'desconhecida':
        return 'legada';
    }
  }

  // Sem cabeçalho: os três momentos da SPEC-027. `em_andamento` **não** conta
  // como pendência — o ponto vermelho significa "você esqueceu", não "está
  // acontecendo agora".
  if (!aulaJaComecou(o.data, o.horaInicio, agora)) return 'futura';
  if (!aulaJaTerminou(o.data, o.horaFim, agora)) return 'em_andamento';
  return 'pendente';
}

/**
 * "A chamada já foi registrada?" — a pergunta booleana que os consumidores
 * faziam cada um do seu jeito.
 *
 * `nao_houve` conta como registrada: alguém respondeu pela aula, e o produto
 * não tem mais nada a pedir sobre ela. É essa linha que faz o ponto vermelho
 * sumir.
 */
export function chamadaJaRegistrada(estado: EstadoDaChamada): boolean {
  return estado === 'feita' || estado === 'legada' || estado === 'nao_houve';
}

/**
 * "Isto ainda cobra ação do professor?" — o que pinta o vermelho no
 * calendário. Só `pendente`: `em_andamento` está acontecendo, `futura` não
 * aconteceu, `cancelada` não vai acontecer e os três registrados já foram
 * respondidos.
 */
export function chamadaPendente(estado: EstadoDaChamada): boolean {
  return estado === 'pendente';
}

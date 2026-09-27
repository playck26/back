/**
 * SPEC-076/D11 — **a decisão de tempo do portão da chamada, como função
 * pura do instante.**
 *
 * O portão (`PresencaService.travarEValidarOcorrencia`) lê `agora` uma vez, do
 * `RelogioDaPresenca`, e entrega a decisão a esta função. Tudo o que depende
 * de tempo — a aula já começou, a janela retroativa, a janela da automática —
 * sai de `entrada.agora`, e de nada mais.
 *
 * Por que uma função à parte: cinco rodadas de validação mostraram que
 * "procurar outro relógio no código" não fecha — sempre há outra forma
 * (alias, helper, callback, dependência). Isolada, a função é provada por
 * CONSTRUÇÃO no teste de unidade: roda num realm sem relógio (`Date` e `Intl`
 * neutralizados, sem `process`, `performance`, timers nem `require` de pacote)
 * e com cobertura total de blocos — qualquer leitura de relógio, por qualquer
 * caminho, falha ali. Este módulo, por isso, só importa do `date-time.util`.
 */
import { aulaJaComecou, hojeNoFusoDoClube } from '../courts/date-time.util';

/** SPEC-014/INV-017: janela em que a chamada pode ser lançada. */
export const JANELA_RETROATIVA_DIAS = 7;

/**
 * SPEC-057/TASK-001/D5 — a janela de correção da chamada que **nasceu
 * automática**, contada do fechamento automático e não da data da aula.
 * O mesmo número da INV-017, mas outro relógio: retomada tardia fecha aula
 * antiga, e cada fechamento abre a sua própria janela (LIM-057l).
 */
export const JANELA_DA_AUTOMATICA_DIAS = 7;

const MS_DIA = 24 * 60 * 60 * 1000;

export interface EntradaDeTempo {
  /** O instante que o portão leu, uma vez. Obrigatório: sem ele, erro. */
  agora: Date;
  /** `ocupacoes_quadra.data` (meia-noite UTC do dia da aula). */
  data: Date;
  /** `ocupacoes_quadra.hora_inicio` (`@db.Time`, ancorado em 1970-01-01Z). */
  horaInicio: Date;
  /** `chamadas.origem_inicial`, ou `null` sem cabeçalho. */
  origemInicial: string | null;
  /** `chamadas.fechada_automaticamente_em`, ou `null`. */
  fechadaAutomaticamenteEm: Date | null;
}

export type RecusaDeTempo =
  'AULA_FUTURA' | 'AULA_ANTIGA_AUTOMATICA' | 'AULA_ANTIGA_RETROATIVA';

export interface DecisaoDeTempo {
  /** `fechada + 7 dias > agora`; `null` sem fechamento automático. */
  dentroDaJanelaAutomatica: boolean | null;
  recusa: RecusaDeTempo | null;
}

export function decidirTempoDoPortao(entrada: EntradaDeTempo): DecisaoDeTempo {
  const { agora, data, horaInicio, origemInicial, fechadaAutomaticamenteEm } =
    entrada;
  // Sem `agora`, os helpers do `date-time.util` cairiam no relógio padrão
  // deles (`= new Date()`). Aqui isso é erro, e não um segundo relógio.
  if (!(agora instanceof Date) || Number.isNaN(agora.getTime())) {
    throw new TypeError('decidirTempoDoPortao: `agora` é obrigatório');
  }
  const dentroDaJanelaAutomatica =
    fechadaAutomaticamenteEm === null
      ? null
      : fechadaAutomaticamenteEm.getTime() +
          JANELA_DA_AUTOMATICA_DIAS * MS_DIA >
        agora.getTime();

  // INV-017. O limite futuro impede a chamada de virar previsão. SPEC-027: o
  // portão olha a HORA, não só o dia. A comparação por dia fica como rede de
  // segurança na mesma condição: se `aulaJaComecou` regredir, ela ainda barra
  // a aula de amanhã.
  const hoje = hojeNoFusoDoClube(agora).getTime();
  const dia = data.getTime();
  if (!(aulaJaComecou(data, horaInicio, agora) && dia <= hoje)) {
    return { dentroDaJanelaAutomatica, recusa: 'AULA_FUTURA' };
  }

  // SPEC-057/TASK-001/D5 — a chamada que nasceu automática usa
  // exclusivamente o relógio do fechamento, inclusive depois de ratificada.
  if (origemInicial === 'automatica') {
    return {
      dentroDaJanelaAutomatica,
      recusa:
        dentroDaJanelaAutomatica === true ? null : 'AULA_ANTIGA_AUTOMATICA',
    };
  }

  // O limite passado existe porque a turma de hoje deixa de ser um retrato
  // confiável do que era há muito tempo (LIM-003).
  return {
    dentroDaJanelaAutomatica,
    recusa:
      dia < hoje - JANELA_RETROATIVA_DIAS * MS_DIA
        ? 'AULA_ANTIGA_RETROATIVA'
        : null,
  };
}

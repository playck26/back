import { formatDateOnly, formatTimeOnly } from '../courts/date-time.util';

/**
 * SPEC-074/D8 — **o aviso de que o horário vagou.**
 *
 * | Campo | Valor | Regra herdada |
 * |---|---|---|
 * | `tipo` | `pre_reserva` | fora de `gesto` e de `teste`: a caixa o mostra sem código novo (SPEC-065/D6) |
 * | `titulo` | `Horário livre` | vocabulário da bandeja, ao lado de `Sua vez` (SPEC-064/D7) |
 * | `corpo` | dia e hora, e **nada de `quadras.nome`** | INV-063a: sem texto livre de tabela (LIM-074d) |
 * | `destino_url` | `/quadras/<id>?data=<dia>` | id, nunca slug |
 * | `expira_em` | o início do horário | é do ENVIO, não da caixa (SPEC-065/D7) |
 *
 * **A última frase do corpo é o LIM-074a dito ao aluno.** Sem ela, "vagou"
 * seria lido como "é seu", e o primeiro que chegasse tarde culparia o app.
 */

/** O `tipo` da linha em `notificacoes` — e o predicado do índice parcial e
 *  do CHECK de origem da migration. Mudar aqui sem mudar lá desliga os dois. */
export const TIPO_PRE_RESERVA = 'pre_reserva';

export const TITULO_DA_PRE_RESERVA = 'Horário livre';

export interface FatosDoHorarioLivre {
  quadraId: string;
  data: Date;
  horaInicio: Date;
  /** O instante do início, já no fuso do clube (D6). */
  inicioEm: Date;
}

export interface AvisoDoHorarioLivre {
  titulo: string;
  corpo: string;
  destinoUrl: string;
  expiraEm: Date;
}

export function montarAvisoDaPreReserva(
  fatos: FatosDoHorarioLivre,
): AvisoDoHorarioLivre {
  const dia = formatDateOnly(fatos.data); // AAAA-MM-DD, sem fuso: é `@db.Date`
  const [, mes, diaDoMes] = dia.split('-');
  const hora = formatTimeOnly(fatos.horaInicio); // HH:MM, sem fuso: é `@db.Time`
  return {
    titulo: TITULO_DA_PRE_RESERVA,
    corpo: `O horário de ${diaDoMes}/${mes} às ${hora} que você esperava vagou. Quem reservar primeiro fica com ele.`,
    // Id, nunca slug; e a DATA, para a tela abrir no dia certo (D10).
    destinoUrl: `/quadras/${fatos.quadraId}?data=${dia}`,
    // Depois de o horário começar, o push é inútil. A caixa continua mostrando.
    expiraEm: fatos.inicioEm,
  };
}

/**
 * SPEC-077/TASK-000 — **datas de teste relativas ao hoje do clube.**
 *
 * Uma data futura FIXA numa fixture vira passado com o tempo, e o teste muda
 * de resposta sem nada ter mudado no código: `fit-022` quebraria o CI em
 * 2026-10-05; `creditos-reserva`, em 2031. Quem precisa de "uma data futura"
 * pede aqui. A sonda `test/sonda-relogio-adiantado.js` é o que confere que
 * nenhum teste voltou a depender de data fixa.
 */
import {
  formatDateOnly,
  hojeNoFusoDoClube,
} from '../../src/courts/date-time.util';

const MS_DIA = 24 * 60 * 60 * 1000;

/** `AAAA-MM-DD` de hoje, no fuso do clube, mais `dias`. */
export function diaNoFuturo(dias: number): string {
  return formatDateOnly(
    new Date(hojeNoFusoDoClube().getTime() + dias * MS_DIA),
  );
}

/**
 * A primeira data com o dia da semana pedido (`0` = domingo … `6` = sábado),
 * a partir de hoje + `aPartirDe` dias. Para as fixturas que gravam a janela do
 * professor num dia da semana e precisam de uma data que case com ele.
 */
export function proximoDiaDaSemana(diaSemana: number, aPartirDe = 30): string {
  const base = hojeNoFusoDoClube().getTime() + aPartirDe * MS_DIA;
  const delta = (diaSemana - new Date(base).getUTCDay() + 7) % 7;
  return formatDateOnly(new Date(base + delta * MS_DIA));
}

/** `data` (`AAAA-MM-DD`) mais `dias`. */
export function somarDias(data: string, dias: number): string {
  return formatDateOnly(
    new Date(Date.parse(`${data}T00:00:00.000Z`) + dias * MS_DIA),
  );
}

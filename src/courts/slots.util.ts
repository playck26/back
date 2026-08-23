import { UnprocessableEntityException } from '@nestjs/common';

export interface SlotSolicitado {
  horaInicio: string;
  horaFim: string;
}

export interface BlocoDeReserva {
  horaInicio: string;
  horaFim: string;
  horas: number;
}

/** SPEC-011: proteção contra seleção acidental, não regra de negócio. */
export const MAX_HORAS_POR_BLOCO = 6;

function paraMinutos(hora: string): number {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * SPEC-011/REQ-001 — agrupa slots contíguos em blocos.
 *
 * **A junção acontece no servidor, não na tela.** Se dependesse do
 * cliente, o app do aluno e o painel do admin poderiam ter regras de
 * junção divergentes para o mesmo pedido — e a mesma seleção viraria uma
 * reserva num lugar e duas no outro.
 *
 * Contíguo é `horaFim === horaInicio` do próximo. Slots fora de ordem são
 * ordenados (conveniência óbvia); **duplicados são erro**, porque aceitar
 * em silêncio faria o valor somar duas vezes a mesma hora.
 */
export function agruparEmBlocos(slots: SlotSolicitado[]): BlocoDeReserva[] {
  if (slots.length === 0) {
    throw new UnprocessableEntityException('Selecione ao menos um horário.');
  }

  for (const slot of slots) {
    if (paraMinutos(slot.horaFim) <= paraMinutos(slot.horaInicio)) {
      throw new UnprocessableEntityException(
        `Horário inválido: ${slot.horaInicio}–${slot.horaFim}.`,
      );
    }
  }

  const ordenados = [...slots].sort(
    (a, b) => paraMinutos(a.horaInicio) - paraMinutos(b.horaInicio),
  );

  const vistos = new Set<string>();
  for (const slot of ordenados) {
    const chave = `${slot.horaInicio}-${slot.horaFim}`;
    if (vistos.has(chave)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'SLOT_DUPLICADO',
        message: `O horário ${chave} aparece duas vezes na seleção.`,
      });
    }
    vistos.add(chave);
  }

  // Sobreposição entre slots do mesmo pedido é erro antes de qualquer
  // consulta: a pessoa está pedindo o mesmo minuto duas vezes, e o
  // conflito com o banco (INV-001) não descreveria o problema.
  for (let i = 1; i < ordenados.length; i++) {
    if (
      paraMinutos(ordenados[i].horaInicio) <
      paraMinutos(ordenados[i - 1].horaFim)
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'SLOTS_SOBREPOSTOS',
        message: 'Os horários selecionados se sobrepõem.',
      });
    }
  }

  const blocos: BlocoDeReserva[] = [];
  for (const slot of ordenados) {
    const ultimo = blocos.at(-1);
    if (ultimo && ultimo.horaFim === slot.horaInicio) {
      ultimo.horaFim = slot.horaFim;
      ultimo.horas =
        (paraMinutos(ultimo.horaFim) - paraMinutos(ultimo.horaInicio)) / 60;
      continue;
    }
    blocos.push({
      horaInicio: slot.horaInicio,
      horaFim: slot.horaFim,
      horas: (paraMinutos(slot.horaFim) - paraMinutos(slot.horaInicio)) / 60,
    });
  }

  for (const bloco of blocos) {
    if (bloco.horas > MAX_HORAS_POR_BLOCO) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'BLOCO_LONGO_DEMAIS',
        message: `Uma reserva contínua pode ter no máximo ${MAX_HORAS_POR_BLOCO} horas (${bloco.horaInicio}–${bloco.horaFim} tem ${bloco.horas}).`,
      });
    }
  }

  return blocos;
}

/**
 * SPEC-011/AC-010 — impressão digital do pedido.
 *
 * Normaliza antes de calcular: a mesma seleção enviada em ordem diferente
 * é o **mesmo** pedido, e um retry não deve virar `422` por causa da ordem
 * em que a tela montou o array.
 */
export function fingerprintDoPedido(
  quadraId: string,
  data: string,
  slots: SlotSolicitado[],
): string {
  const normalizado = [...slots]
    .map((s) => `${s.horaInicio}-${s.horaFim}`)
    .sort()
    .join(',');
  return `${quadraId}|${data}|${normalizado}`;
}

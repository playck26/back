import { UnprocessableEntityException } from '@nestjs/common';
import { agruparEmBlocos, fingerprintDoPedido } from './slots.util';

// TEST-011 (SPEC-011): a regra que o usuário enxerga — "das 9 às 11 é uma
// reserva" — testada isolada, com os casos estranhos que aparecem em
// produção antes de aparecer em revisão.

const slot = (horaInicio: string, horaFim: string) => ({ horaInicio, horaFim });

describe('agruparEmBlocos (SPEC-011/REQ-001)', () => {
  it('AC-001: horas seguidas viram um bloco só', () => {
    expect(
      agruparEmBlocos([slot('09:00', '10:00'), slot('10:00', '11:00')]),
    ).toEqual([{ horaInicio: '09:00', horaFim: '11:00', horas: 2 }]);
  });

  it('AC-002: horas separadas viram blocos independentes', () => {
    expect(
      agruparEmBlocos([slot('09:00', '10:00'), slot('15:00', '16:00')]),
    ).toEqual([
      { horaInicio: '09:00', horaFim: '10:00', horas: 1 },
      { horaInicio: '15:00', horaFim: '16:00', horas: 1 },
    ]);
  });

  it('ordena slots fora de ordem antes de agrupar', () => {
    expect(
      agruparEmBlocos([slot('10:00', '11:00'), slot('09:00', '10:00')]),
    ).toEqual([{ horaInicio: '09:00', horaFim: '11:00', horas: 2 }]);
  });

  // Aceitar duplicado em silêncio faria o valor somar duas vezes a mesma
  // hora — a pessoa pagaria por duas e teria uma.
  it('recusa slot duplicado', () => {
    expect(() =>
      agruparEmBlocos([slot('09:00', '10:00'), slot('09:00', '10:00')]),
    ).toThrow(UnprocessableEntityException);
  });

  it('recusa slots sobrepostos com mensagem própria, não como conflito de agenda', () => {
    expect(() =>
      agruparEmBlocos([slot('09:00', '11:00'), slot('10:00', '12:00')]),
    ).toThrow(/sobrep/i);
  });

  it('recusa horário invertido', () => {
    expect(() => agruparEmBlocos([slot('11:00', '09:00')])).toThrow(
      UnprocessableEntityException,
    );
  });

  it('recusa seleção vazia', () => {
    expect(() => agruparEmBlocos([])).toThrow(UnprocessableEntityException);
  });

  // Proteção contra arrastar o dedo pela grade inteira, não regra de
  // negócio — a mensagem diz o limite e qual bloco o excedeu.
  it('recusa bloco contínuo acima de 6 horas', () => {
    const seteHoras = Array.from({ length: 7 }, (_, i) =>
      slot(
        `${String(8 + i).padStart(2, '0')}:00`,
        `${String(9 + i).padStart(2, '0')}:00`,
      ),
    );

    expect(() => agruparEmBlocos(seteHoras)).toThrow(/máximo 6 horas/);
  });

  it('permite 6 horas seguidas', () => {
    const seisHoras = Array.from({ length: 6 }, (_, i) =>
      slot(
        `${String(8 + i).padStart(2, '0')}:00`,
        `${String(9 + i).padStart(2, '0')}:00`,
      ),
    );

    expect(agruparEmBlocos(seisHoras)).toEqual([
      { horaInicio: '08:00', horaFim: '14:00', horas: 6 },
    ]);
  });
});

describe('fingerprintDoPedido (SPEC-011/AC-010)', () => {
  // A mesma seleção enviada em ordem diferente é o **mesmo** pedido: um
  // retry não pode virar 422 por causa da ordem em que a tela montou o
  // array.
  it('independe da ordem dos slots', () => {
    const a = fingerprintDoPedido('q1', '2026-08-24', [
      slot('09:00', '10:00'),
      slot('15:00', '16:00'),
    ]);
    const b = fingerprintDoPedido('q1', '2026-08-24', [
      slot('15:00', '16:00'),
      slot('09:00', '10:00'),
    ]);

    expect(a).toBe(b);
  });

  it('muda quando a seleção muda', () => {
    const a = fingerprintDoPedido('q1', '2026-08-24', [slot('09:00', '10:00')]);
    const b = fingerprintDoPedido('q1', '2026-08-24', [slot('10:00', '11:00')]);

    expect(a).not.toBe(b);
  });

  it('muda quando a quadra ou a data mudam', () => {
    const base = fingerprintDoPedido('q1', '2026-08-24', [
      slot('09:00', '10:00'),
    ]);

    expect(
      fingerprintDoPedido('q2', '2026-08-24', [slot('09:00', '10:00')]),
    ).not.toBe(base);
    expect(
      fingerprintDoPedido('q1', '2026-08-25', [slot('09:00', '10:00')]),
    ).not.toBe(base);
  });
});

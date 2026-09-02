import type { Prisma } from '@prisma/client';
import {
  horaDeMinutos,
  minutosDaHora,
  parseDateOnly,
  parseTimeOnly,
  recorteTemporal,
} from './date-time.util';

/**
 * SPEC-041/TASK-A2 — **as provas do corte, com relógio fixo.**
 *
 * Todo `agora` aqui é um instante **explícito**, nunca `new Date()`. O gate
 * `fuso-do-clube.spec.ts` não pegaria a diferença — ele proíbe um token só —,
 * então quem garante é este arquivo.
 *
 * ## Por que existe um avaliador de fragmento aqui embaixo
 *
 * A primeira versão destas provas lia `fragmento.OR[1].horaFim.lte` direto.
 * Passava, e **mentia**: trocar `lte` por `lt` fazia as três linhas da tabela
 * de fronteira caírem juntas, por `undefined`, e não porque o comportamento
 * mudou. Um teste que quebra com qualquer edição prova estrutura, não regra —
 * e a linha das 21h00 deixava de ser a prova que ela precisa ser.
 *
 * `casa()` executa o fragmento contra uma reserva, seja qual for o operador.
 * Com ele, a sabotagem `lte → lt` derruba **só** o caso das 21h00 — que é
 * exatamente o ponto: o defeito é invisível um minuto antes e um minuto depois.
 *
 * Referência: 2026-09-15, terça. O fuso do clube é UTC-3.
 */

type Reserva = { data: Date; horaFim: Date };

/** Avalia o fragmento de `where` contra uma reserva, como o Postgres faria. */
function casa(
  fragmento: Prisma.OcupacaoQuadraWhereInput,
  reserva: Reserva,
): boolean {
  const pernas = fragmento.OR as Array<Record<string, unknown>>;
  return pernas.some((perna) =>
    Object.entries(perna).every(([campo, cond]) => {
      const valor = reserva[campo as keyof Reserva].getTime();
      if (cond instanceof Date) return valor === cond.getTime();
      const ops = cond as Record<string, Date>;
      return Object.entries(ops).every(([op, alvo]) => {
        const t = alvo.getTime();
        switch (op) {
          case 'lt':
            return valor < t;
          case 'lte':
            return valor <= t;
          case 'gt':
            return valor > t;
          case 'gte':
            return valor >= t;
          case 'equals':
            return valor === t;
          default:
            throw new Error(`operador não previsto no avaliador: ${op}`);
        }
      });
    }),
  );
}

/** Um instante UTC a partir da hora **local do clube** (UTC-3). */
function instanteNoClube(dia: string, hora: string): Date {
  return new Date(`${dia}T${hora}:00.000-03:00`);
}

const HOJE = parseDateOnly('2026-09-15');

describe('horaDeMinutos (SPEC-041)', () => {
  // O par ida-e-volta é o que sustenta o helper: `agoraNoFusoDoClube` devolve
  // minutos, a coluna é @db.Time, e o corte compara os dois.
  it.each([0, 1, 59, 60, 480, 1259, 1439])(
    'é o inverso exato de minutosDaHora (%i)',
    (minutos) => {
      expect(minutosDaHora(horaDeMinutos(minutos))).toBe(minutos);
    },
  );

  it('ancora em 1970-01-01Z, como a coluna @db.Time', () => {
    expect(horaDeMinutos(21 * 60).toISOString()).toBe(
      '1970-01-01T21:00:00.000Z',
    );
  });

  it('zera à meia-noite, não vira 24:00', () => {
    expect(horaDeMinutos(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('recorteTemporal — a fronteira (SPEC-041/D1, INV-090)', () => {
  /**
   * **A linha do meio é a prova.** Ela é a única que cai quando alguém escreve
   * `hora_fim < agora` de um lado e `hora_fim > agora` do outro — a
   * implementação mais provável de todas, em que a reserva que termina agora
   * some das DUAS abas. As vizinhas continuam verdes nesse defeito.
   */
  const RESERVA: Reserva = { data: HOJE, horaFim: parseTimeOnly('21:00') };

  it.each([
    ['20:59', 'futuras'],
    ['21:00', 'anteriores'],
    ['21:01', 'anteriores'],
  ] as const)('às %s a reserva que termina 21h00 é %s', (hora, esperado) => {
    const agora = instanteNoClube('2026-09-15', hora);

    const emAnteriores = casa(recorteTemporal('anteriores', agora), RESERVA);
    const emFuturas = casa(recorteTemporal('futuras', agora), RESERVA);

    expect(emAnteriores).toBe(esperado === 'anteriores');
    expect(emFuturas).toBe(esperado === 'futuras');

    // INV-090 no mesmo relógio: exatamente uma das duas. Nunca zero (o item
    // sumiria da tela), nunca duas (apareceria em dobro).
    expect([emAnteriores, emFuturas].filter(Boolean)).toHaveLength(1);
  });

  it('D-I4: às 20h, a reserva das 19h às 21h ainda está na primeira aba', () => {
    const agora = instanteNoClube('2026-09-15', '20:00');
    const emAndamento: Reserva = {
      data: HOJE,
      horaFim: parseTimeOnly('21:00'),
    };

    expect(casa(recorteTemporal('futuras', agora), emAndamento)).toBe(true);
    expect(casa(recorteTemporal('anteriores', agora), emAndamento)).toBe(false);
  });
});

describe('recorteTemporal — a partição, num conjunto inteiro (INV-090)', () => {
  /**
   * A fronteira provada acima é um item. Esta é a propriedade sobre o
   * conjunto: **soma das duas abas = total, interseção vazia**, em todos os
   * relógios que importam.
   */
  const CONJUNTO: Reserva[] = [
    { data: parseDateOnly('2026-09-14'), horaFim: parseTimeOnly('23:00') }, // ontem
    { data: HOJE, horaFim: parseTimeOnly('08:00') },
    { data: HOJE, horaFim: parseTimeOnly('21:00') }, // a do minuto redondo
    { data: HOJE, horaFim: parseTimeOnly('23:00') },
    { data: parseDateOnly('2026-09-16'), horaFim: parseTimeOnly('08:00') }, // amanhã cedo
  ];

  it.each(['00:00', '07:59', '08:00', '20:59', '21:00', '21:01', '23:59'])(
    'às %s cada reserva cai em exatamente uma aba',
    (hora) => {
      const agora = instanteNoClube('2026-09-15', hora);
      const futuras = CONJUNTO.filter((r) =>
        casa(recorteTemporal('futuras', agora), r),
      );
      const anteriores = CONJUNTO.filter((r) =>
        casa(recorteTemporal('anteriores', agora), r),
      );

      expect(futuras.length + anteriores.length).toBe(CONJUNTO.length);
      expect(futuras.filter((r) => anteriores.includes(r))).toHaveLength(0);
    },
  );
});

describe('recorteTemporal — os outros dias (SPEC-041/D1)', () => {
  /**
   * A armadilha do `AND` ingênuo. `data >= dia AND hora_fim > agora` descarta
   * as manhãs dos dias futuros: às 9h de hoje, a reserva das 8h de amanhã
   * sumiria da aba `Reservas`, porque `08:00 > 09:00` é falso.
   *
   * A forma de duas pernas em `OR` não tem esse buraco — para os outros dias,
   * quem decide é a `data` sozinha, e a hora nem é olhada.
   */
  it('reserva das 8h de AMANHÃ continua futura às 9h de hoje', () => {
    const agora = instanteNoClube('2026-09-15', '09:00');
    const amanhaCedo: Reserva = {
      data: parseDateOnly('2026-09-16'),
      horaFim: parseTimeOnly('08:00'),
    };

    expect(casa(recorteTemporal('futuras', agora), amanhaCedo)).toBe(true);
    expect(casa(recorteTemporal('anteriores', agora), amanhaCedo)).toBe(false);
  });

  it('reserva de ONTEM à noite é anterior à 00h01 de hoje', () => {
    const agora = instanteNoClube('2026-09-15', '00:01');
    const ontemTarde: Reserva = {
      data: parseDateOnly('2026-09-14'),
      horaFim: parseTimeOnly('23:00'),
    };

    expect(casa(recorteTemporal('anteriores', agora), ontemTarde)).toBe(true);
    expect(casa(recorteTemporal('futuras', agora), ontemTarde)).toBe(false);
  });

  it('a perna de outro dia não compara hora nenhuma', () => {
    const agora = instanteNoClube('2026-09-15', '09:00');
    const futuras = recorteTemporal('futuras', agora).OR as Array<
      Record<string, unknown>
    >;

    expect(futuras[0]).toEqual({ data: { gt: HOJE } });
    expect(futuras[0].horaFim).toBeUndefined();
  });
});

describe('recorteTemporal — o fuso (SPEC-041/INV-091)', () => {
  /**
   * DEF-020, terceira vez neste projeto: das 21h à meia-noite locais, o UTC já
   * está no dia seguinte. Às 21h30 de 15/09 em São Paulo, o UTC diz 16/09 — e
   * o corte usaria o dia errado, mandando para "anterior" tudo o que ainda vai
   * acontecer hoje à noite.
   */
  const AS_21H30_LOCAL = new Date('2026-09-16T00:30:00.000Z');

  it('às 21h30 de São Paulo o dia do corte é 15/09, não 16/09', () => {
    const or = recorteTemporal('futuras', AS_21H30_LOCAL).OR as Array<{
      data?: { gt?: Date } | Date;
    }>;

    expect(or[0]).toEqual({ data: { gt: HOJE } });
    expect((or[1] as { data: Date }).data).toEqual(HOJE);
  });

  it('e a hora do corte é 21h30 local, não 00h30 UTC', () => {
    const or = recorteTemporal('anteriores', AS_21H30_LOCAL).OR as Array<{
      horaFim?: { lte?: Date };
    }>;

    expect(or[1].horaFim).toEqual({ lte: parseTimeOnly('21:30') });
  });

  it('a reserva das 23h de hoje continua futura às 21h30, apesar do UTC', () => {
    const hojeTarde: Reserva = { data: HOJE, horaFim: parseTimeOnly('23:00') };

    expect(casa(recorteTemporal('futuras', AS_21H30_LOCAL), hojeTarde)).toBe(
      true,
    );
  });
});

import type { Prisma } from '@prisma/client';
import {
  aindaSePodeMarcar,
  antecedenciaEmMinutos,
} from './ocorrencia-relevante';
import {
  avaliarSaidaDeTurma,
  type PrazoDeCancelamento,
} from '../company-settings/prazo-de-cancelamento';
import { parseDateOnly, parseTimeOnly } from '../courts/date-time.util';

/**
 * DEF-041 — **a lista de reposição e o `POST` não podem discordar.**
 *
 * O `where` de `aindaSePodeMarcar` é avaliado aqui como o banco o avaliaria,
 * e comparado com o veredito que `marcarNaTransacao` dá à mesma ocorrência
 * (`avaliarSaidaDeTurma` sobre `antecedenciaEmMinutos`). A grade cobre os
 * minutos que carregam a regra: o início exato, um minuto antes e depois, o
 * fim do dia, a meia-noite, e prazos que empurram o corte para outro dia.
 */

/**
 * O `where` devolvido, avaliado numa linha — `data` e `hora_inicio`.
 *
 * A forma é travada antes: um campo ou uma perna a mais (um `horaFim`, por
 * exemplo) seria ignorado por este avaliador e passaria pela grade. E a hora
 * é comparada como o Postgres compara um `time`, com os segundos — não pelo
 * `minutosDaHora` que o `POST` usa, senão os dois lados errariam juntos.
 */
function passaNoWhere(
  w: Prisma.OcupacaoQuadraWhereInput,
  data: Date,
  horaInicio: Date,
): boolean {
  expect(w).toStrictEqual({
    OR: [
      { data: { gt: expect.any(Date) } },
      { data: expect.any(Date), horaInicio: { gte: expect.any(Date) } },
    ],
  });
  const [dias, mesmoDia] = w.OR as [
    { data: { gt: Date } },
    { data: Date; horaInicio: { gte: Date } },
  ];
  if (data.getTime() > dias.data.gt.getTime()) return true;
  return (
    data.getTime() === mesmoDia.data.getTime() &&
    horaInicio.getTime() >= mesmoDia.horaInicio.gte.getTime()
  );
}

function postAceita(
  prazo: PrazoDeCancelamento,
  data: Date,
  horaInicio: Date,
  agora: Date,
): boolean {
  return avaliarSaidaDeTurma({
    papelDoAutor: 'aluno',
    agora,
    ocorrenciaRelevante: {
      tipo: 'MINUTOS',
      minutos: antecedenciaEmMinutos(data, horaInicio, agora),
    },
    prazo,
  }).permitido;
}

/** `hh:mm` no fuso do clube (UTC-3) do dia 2026-11-12, como instante. */
const agoraAs = (hhmm: string, dia = '2026-11-12') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, Number(dia.slice(8)), h + 3, m, 17));
};

const dia = (n: number) =>
  parseDateOnly(`2026-11-${String(n).padStart(2, '0')}`);
const hora = (hhmm: string) => parseTimeOnly(hhmm);

describe('aindaSePodeMarcar (DEF-041)', () => {
  it('o relato: às 18h38, sem prazo, a aula das 7h e a das 18h de hoje saem', () => {
    const w = aindaSePodeMarcar({ regra: 'SEM_PRAZO' }, agoraAs('18:38'));
    const hoje = dia(12);
    expect(passaNoWhere(w, hoje, hora('07:00'))).toBe(false);
    expect(passaNoWhere(w, hoje, hora('18:00'))).toBe(false);
    expect(passaNoWhere(w, hoje, hora('19:00'))).toBe(true);
    expect(passaNoWhere(w, dia(13), hora('07:00'))).toBe(true);
  });

  it('com prazo de 2h, às 18h38 a das 19h também sai — o POST a recusaria', () => {
    const w = aindaSePodeMarcar({ regra: 'HORAS', horas: 2 }, agoraAs('18:38'));
    expect(passaNoWhere(w, dia(12), hora('19:00'))).toBe(false);
    expect(passaNoWhere(w, dia(12), hora('20:38'))).toBe(true);
    expect(passaNoWhere(w, dia(12), hora('20:37'))).toBe(false);
  });

  it('a aula que começa EXATAMENTE agora sai, sem prazo (minutos = 0 recusa)', () => {
    const w = aindaSePodeMarcar({ regra: 'SEM_PRAZO' }, agoraAs('19:00'));
    expect(passaNoWhere(w, dia(12), hora('19:00'))).toBe(false);
    expect(passaNoWhere(w, dia(12), hora('19:01'))).toBe(true);
  });

  it('o prazo atravessa a meia-noite: 2h às 23h corta amanhã à 1h', () => {
    const w = aindaSePodeMarcar({ regra: 'HORAS', horas: 2 }, agoraAs('23:00'));
    expect(passaNoWhere(w, dia(12), hora('23:30'))).toBe(false);
    expect(passaNoWhere(w, dia(13), hora('00:30'))).toBe(false);
    expect(passaNoWhere(w, dia(13), hora('01:00'))).toBe(true);
  });

  it('a grade inteira: o where e o POST dão o mesmo veredito em toda ocorrência', () => {
    const prazos: PrazoDeCancelamento[] = [
      { regra: 'SEM_PRAZO' },
      { regra: 'HORAS', horas: 1 },
      { regra: 'HORAS', horas: 2 },
      { regra: 'HORAS', horas: 24 },
      { regra: 'HORAS', horas: 48 },
    ];
    const agoras = [
      '00:00',
      '00:01',
      '06:59',
      '07:00',
      '17:38',
      '18:00',
      '18:38',
      '18:59',
      '19:00',
      '22:00',
      '23:00',
      '23:58',
      '23:59',
    ].map((h) => agoraAs(h));
    const horas = [
      '00:00',
      '00:01',
      '00:59',
      '01:00',
      '06:59',
      '07:00',
      '17:38',
      '17:39',
      '18:00',
      '18:38',
      '18:39',
      '19:00',
      '20:38',
      '22:00',
      '23:00',
      '23:59',
    ]
      .map(hora)
      // `@db.Time` guarda segundos: o Postgres compara 18:38:30 inteiro, e o
      // `POST` trunca para 18:38. Os dois têm de concordar mesmo assim.
      .concat(
        [
          [18, 38, 30],
          [18, 39, 59],
          [0, 59, 59],
        ].map(([h, m, s]) => new Date(Date.UTC(1970, 0, 1, h, m, s))),
      );
    const dias = [11, 12, 13, 14, 15].map(dia);

    let casos = 0;
    let aceitos = 0;
    const divergencias: string[] = [];
    for (const prazo of prazos) {
      for (const agora of agoras) {
        const w = aindaSePodeMarcar(prazo, agora);
        for (const d of dias) {
          for (const h of horas) {
            casos += 1;
            const lista = passaNoWhere(w, d, h);
            const post = postAceita(prazo, d, h, agora);
            if (post) aceitos += 1;
            if (lista !== post) {
              divergencias.push(
                `${JSON.stringify(prazo)} agora=${agora.toISOString()} aula=${d.toISOString().slice(0, 10)} ${h.toISOString().slice(11, 16)} lista=${lista} post=${post}`,
              );
            }
          }
        }
      }
    }
    expect(divergencias).toEqual([]);
    // A grade não é ilustração: 5 × 13 × 5 × 19, com os dois vereditos.
    expect(casos).toBe(6175);
    expect(aceitos).toBeGreaterThan(0);
    expect(aceitos).toBeLessThan(casos);
  });
});

import { FUSO_DO_CLUBE, hojeNoFusoDoClube } from './date-time.util';

/**
 * SPEC-023 — **a prova do fuso, e ela guarda um defeito que já existe.**
 *
 * O projeto não tinha fuso em lugar nenhum: `grep -rn "America/"` não
 * devolvia nada, e "hoje" era `Date.UTC(...)` do relógio do servidor —
 * `ClassesService.myUpcomingClasses` faz isso **até hoje**.
 *
 * Para quase tudo isso passa despercebido. Para a regra "não sai no dia da
 * aula" (REQ-004) não passa: o Brasil é UTC-3, então **das 21h à meia-noite
 * locais o UTC já está no dia seguinte**. Aula de terça 19h, aluno tentando
 * sair às 21h30 de segunda — em UTC já é terça, e ele levaria `AULA_HOJE` no
 * dia errado.
 *
 * **Aula à noite é o horário mais comum de clube de tênis.** O caso raro é o
 * caso normal, e é por isso que estas provas usam justamente esse horário.
 */
describe('hojeNoFusoDoClube', () => {
  it('às 21h30 de uma segunda em São Paulo, "hoje" ainda é segunda', () => {
    // 2026-08-24 é uma segunda. 21h30 em São Paulo = 00h30 UTC de terça.
    const seguraANoite = new Date('2026-08-25T00:30:00.000Z');

    expect(hojeNoFusoDoClube(seguraANoite).toISOString().slice(0, 10)).toBe(
      '2026-08-24',
    );
  });

  it('e o cálculo ingênuo em UTC erraria esse mesmo instante', () => {
    // Esta prova não testa o nosso código: ela **documenta o defeito** que a
    // função existe para evitar, e falha se alguém "simplificar" a função de
    // volta para UTC achando que dá no mesmo.
    const seguraANoite = new Date('2026-08-25T00:30:00.000Z');
    const ingenuo = new Date(
      Date.UTC(
        seguraANoite.getUTCFullYear(),
        seguraANoite.getUTCMonth(),
        seguraANoite.getUTCDate(),
      ),
    );

    expect(ingenuo.toISOString().slice(0, 10)).toBe('2026-08-25');
    expect(hojeNoFusoDoClube(seguraANoite)).not.toEqual(ingenuo);
  });

  it('de manhã, os dois concordam — é a hora em que o defeito não aparece', () => {
    // 09h em São Paulo = 12h UTC do mesmo dia. É por isso que o problema
    // sobrevive: quem testa de manhã nunca o vê.
    const deManha = new Date('2026-08-24T12:00:00.000Z');

    expect(hojeNoFusoDoClube(deManha).toISOString().slice(0, 10)).toBe(
      '2026-08-24',
    );
  });

  it('devolve meia-noite UTC, que é o formato das colunas @db.Date', () => {
    const data = hojeNoFusoDoClube(new Date('2026-08-24T12:00:00.000Z'));

    expect(data.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('o fuso é explícito, não herdado do relógio do servidor', () => {
    // O servidor roda em UTC (DigitalOcean). Herdar o fuso dele seria
    // herdar uma decisão que ninguém tomou.
    expect(FUSO_DO_CLUBE).toBe('America/Sao_Paulo');
  });
});

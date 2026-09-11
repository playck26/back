import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizarNascimento } from './normalizar-nascimento';

/**
 * SPEC-036/AC-004 — a data de nascimento, do corpo para o banco.
 *
 * **Este arquivo existe porque nem toda recusa daqui é alcançável por HTTP.**
 * `@IsISO8601({ strict: true })` já barra formato e calendário no `PATCH`, e o
 * e2e confirma que a resposta ali é `400`. O que sobra para cá:
 *
 * - o que a SPEC-038 vai exercitar quando importar aluno por planilha, sem
 *   passar por DTO nenhum;
 * - a distinção `undefined` (não mexe) × `null` (apaga), que é do Prisma e
 *   não do HTTP;
 * - o fuso, que é o defeito recorrente deste projeto.
 */
/** O `code` da recusa, e **falha se a função passar** — `toThrow()` sozinho
 *  ficaria verde para qualquer exceção, inclusive a errada. */
function codigoDoErro(acao: () => unknown): string {
  try {
    acao();
  } catch (erro) {
    const e = erro as { getResponse?: () => { code?: string } };
    return e.getResponse?.().code ?? 'SEM_CODE';
  }
  throw new Error('a função PASSOU, e deveria ter recusado');
}

describe('SPEC-036 — normalizarNascimento', () => {
  it('`undefined` não mexe; `null` apaga', () => {
    // Duas intenções diferentes, e o Prisma já as distingue. Traduzir uma na
    // outra apagaria dado por engano — ou deixaria de apagar quando pedido.
    expect(normalizarNascimento(undefined)).toBeUndefined();
    expect(normalizarNascimento(null)).toBeNull();
  });

  it('data válida vira meia-noite UTC, e o dia não escorrega', () => {
    // `new Date('1990-05-10')` é meia-noite UTC, e a coluna é `DATE`. Em fuso
    // negativo isso já virou o dia anterior neste projeto mais de uma vez
    // (DEF-020) — `Date.UTC` com as partes explícitas não tem o problema.
    const d = normalizarNascimento('1990-05-10');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe('1990-05-10T00:00:00.000Z');
  });

  it('`2026-02-31` é recusada — a rede que a planilha vai precisar', () => {
    // Pelo HTTP o decorador pega antes. Pela SPEC-038 não haverá decorador,
    // e `Date.UTC(2026, 1, 31)` vira 3 de março **em silêncio**: gravar uma
    // data como outra é pior que recusar.
    // **Pelo `code`, nunca pelo texto** — a mesma regra do D7 da SPEC-033. A
    // primeira versão deste caso casava a mensagem por regex e falhou pelo
    // acento: "calendario" sem `á`. Casar texto é o que aquele D7 baniu.
    expect(codigoDoErro(() => normalizarNascimento('2026-02-31'))).toBe(
      'DATA_NASCIMENTO_INVALIDA',
    );
  });

  it('formato solto é recusado, com o MESMO código', () => {
    for (const ruim of ['10/05/1990', '1990-5-10', '1990-05-10T00:00:00Z']) {
      expect(codigoDoErro(() => normalizarNascimento(ruim))).toBe(
        'DATA_NASCIMENTO_INVALIDA',
      );
    }
  });

  it('futuro e anterior a 1900 são recusados', () => {
    expect(codigoDoErro(() => normalizarNascimento('2099-01-01'))).toBe(
      'DATA_NASCIMENTO_INVALIDA',
    );
    // O dedo escorregado: sem o piso, a idade na tela vira 1824 anos.
    expect(codigoDoErro(() => normalizarNascimento('0202-05-10'))).toBe(
      'DATA_NASCIMENTO_INVALIDA',
    );
  });

  it('o TETO é hoje NO FUSO DO CLUBE, e não no relógio UTC do servidor', () => {
    // Às 21h de um 09/09 no Brasil, o UTC já está em 10/09: uma data de
    // "amanhã" passaria pelo teto. O gate `fuso-do-clube.spec.ts` reprovou a
    // primeira versão deste arquivo exatamente por isto.
    const fonte = readFileSync(
      join(__dirname, 'normalizar-nascimento.ts'),
      'utf8',
    );
    expect(fonte).toContain('hojeNoFusoDoClube()');
  });
});

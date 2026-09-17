import {
  CONTRASTE_MINIMO,
  PALETA_DE_QUADRA,
  contrasteContraBranco,
  validarCorDeQuadra,
} from './paleta-de-quadra';

/**
 * SPEC-057/TASK-005/D19/AC-032 — os seis tokens passam contra o substrato
 * branco, e o cálculo é o da norma (luminância sRGB, contraste 1,05/(L+0,05)).
 *
 * Os valores esperados são os que o veredito v4 calculou por conta própria, em
 * PowerShell, sobre o texto da spec — não os que este código produz. Se o
 * código divergir deles, quem errou é o código.
 */
describe('paleta da quadra (D19)', () => {
  it.each([
    ['#00763A', 5.75],
    ['#31658C', 6.23],
    ['#A23B1E', 6.603],
    ['#6B46A3', 6.93],
    ['#8B5E00', 5.677],
    ['#A12B65', 6.888],
  ])('%s tem contraste %s:1 contra branco', (cor, esperado) => {
    expect(contrasteContraBranco(cor)).toBeCloseTo(esperado, 2);
    expect(contrasteContraBranco(cor)).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
  });

  it('a paleta tem exatamente seis cores, distintas, canônicas em maiúsculas', () => {
    expect(PALETA_DE_QUADRA).toHaveLength(6);
    expect(new Set(PALETA_DE_QUADRA).size).toBe(6);
    for (const cor of PALETA_DE_QUADRA) expect(cor).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('extremos do cálculo: preto 21:1, branco 1:1, e um cinza claro abaixo de 3:1', () => {
    expect(contrasteContraBranco('#000000')).toBeCloseTo(21, 5);
    expect(contrasteContraBranco('#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrasteContraBranco('#AAAAAA')).toBeLessThan(CONTRASTE_MINIMO);
  });

  it('undefined passa como "não mexe"; minúscula vira canônica', () => {
    expect(validarCorDeQuadra(undefined)).toBeUndefined();
    expect(validarCorDeQuadra('#6b46a3')).toBe('#6B46A3');
  });

  it.each([null, '', '#FFF', '6B46A3', '#6B46A3FF', '#GGGGGG', '#AAAAAA', 7])(
    '%p → 400 COR_QUADRA_INVALIDA',
    (cor) => {
      try {
        validarCorDeQuadra(cor);
      } catch (e) {
        const r = (
          e as { getResponse(): Record<string, unknown> }
        ).getResponse();
        expect(r).toMatchObject({
          statusCode: 400,
          code: 'COR_QUADRA_INVALIDA',
        });
        return;
      }
      throw new Error('deveria ter recusado');
    },
  );
});

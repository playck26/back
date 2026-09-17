import { BadRequestException } from '@nestjs/common';

/**
 * SPEC-057/TASK-005/D19 — **a paleta fixa das quadras, e a validação dela.**
 *
 * Seis cores, na forma canônica maiúscula. A mesma lista está no CHECK
 * `quadras_cor_paleta_check` da migration `spec057_cor_e_codigo_da_quadra`; a
 * duplicação é deliberada e coberta por db-spec: a API recusa a entrada humana
 * com mensagem, o CHECK recusa o que passar por fora da API.
 *
 * **Repetição é permitida desde a primeira quadra**, e acima de seis quadras é
 * inevitável. A cor é auxiliar (INV-140): quem identifica é nome + Q-código.
 */
export const PALETA_DE_QUADRA = [
  '#00763A',
  '#31658C',
  '#A23B1E',
  '#6B46A3',
  '#8B5E00',
  '#A12B65',
] as const;

export type CorDeQuadra = (typeof PALETA_DE_QUADRA)[number];

/** O substrato fixo do bloco da agenda: branco opaco em todos os estados (D19). */
export const SUBSTRATO_DA_AGENDA = '#FFFFFF';

/** O mínimo de contraste do marcador contra o substrato (WCAG 1.4.11). */
export const CONTRASTE_MINIMO = 3;

const FORMATO = /^#[0-9A-Fa-f]{6}$/;

/**
 * Luminância relativa sRGB, canal normalizado de 0 a 1 (byte/255):
 * canal <= 0,04045 divide por 12,92; senão ((canal+0,055)/1,055)^2,4.
 */
export function luminancia(hex: string): number {
  const canal = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
}

/** Contraste contra o branco: (1 + 0,05) / (L + 0,05), já que L(branco) = 1. */
export function contrasteContraBranco(hex: string): number {
  return 1.05 / (luminancia(hex) + 0.05);
}

function corInvalida(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'COR_QUADRA_INVALIDA',
    message,
    campo: 'cor',
  });
}

/**
 * Normaliza e valida a cor que chegou no corpo.
 *
 * - `undefined` → `undefined`: o create usa o DEFAULT do banco e o update
 *   preserva a cor atual;
 * - `null` → 400: não existe quadra sem cor, e "limpar" não tem significado;
 * - qualquer outra coisa precisa ser `#RRGGBB`, estar na paleta depois de
 *   normalizada e ter contraste >= 3:1 contra o substrato.
 *
 * **O contraste é conferido mesmo sendo a paleta pré-aprovada**, de propósito:
 * se alguém acrescentar uma cor à lista sem medir, a primeira quadra que a
 * usar é recusada aqui, e o teste da paleta falha antes disso.
 */
export function validarCorDeQuadra(cor: unknown): CorDeQuadra | undefined {
  if (cor === undefined) return undefined;
  if (typeof cor !== 'string' || !FORMATO.test(cor)) {
    throw corInvalida('A cor precisa estar no formato #RRGGBB.');
  }
  const canonica = cor.toUpperCase();
  const naPaleta = PALETA_DE_QUADRA.find((c) => c === canonica);
  if (!naPaleta) {
    throw corInvalida('Escolha uma das seis cores da paleta da agenda.');
  }
  if (contrasteContraBranco(naPaleta) < CONTRASTE_MINIMO) {
    throw corInvalida('Esta cor não tem contraste suficiente na agenda.');
  }
  return naPaleta;
}

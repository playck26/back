import { randomInt } from 'node:crypto';

/**
 * SPEC-009/REQ-003 — senha temporária legível.
 *
 * O alfabeto exclui os pares que se confundem quando alguém lê uma senha
 * numa conversa de WhatsApp ou copia de um print: `0/O`, `1/I/L`, `5/S`,
 * `2/Z`, `8/B`. Uma senha temporária que a pessoa digita errado três vezes
 * não é segurança — é chamado de suporte.
 *
 * O prefixo `pck-` existe para a senha ser reconhecível no meio de uma
 * conversa: quem recebe entende que aquilo é a credencial, e quem manda
 * não precisa explicar.
 *
 * 6 caracteres num alfabeto de 27 dão ~28 bits de entropia. É pouco para
 * uma senha permanente e suficiente para esta: vale 7 dias, só serve até
 * a primeira troca (obrigatória, INV-008), o login tem throttle de 10
 * tentativas por 15 minutos por IP (NFR-002 de SPEC-001) e o admin pode
 * invalidá-la gerando outra.
 */
const ALFABETO = 'ACDEFGHJKMNPQRTUVWXY34679';

export function gerarSenhaTemporaria(): string {
  let corpo = '';
  for (let i = 0; i < 6; i += 1) {
    corpo += ALFABETO[randomInt(ALFABETO.length)];
  }
  return `pck-${corpo}`;
}

/** Validade da senha temporária: 7 dias (ADR-013). */
export const SENHA_TEMPORARIA_VALIDADE_MS = 7 * 24 * 60 * 60 * 1000;

export function senhaTemporariaExpiraEm(): Date {
  return new Date(Date.now() + SENHA_TEMPORARIA_VALIDADE_MS);
}

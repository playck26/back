import { SetMetadata } from '@nestjs/common';

export const PERMITE_ACEITE_PENDENTE = 'permiteAceitePendente';

/**
 * SPEC-024/INV-024b — marca as poucas rotas que alguém com aceite pendente
 * ainda pode usar: **ler o que falta aceitar**, **aceitar**, `/auth/me` e
 * logout.
 *
 * Mesma forma do `@PermiteSenhaTemporaria`, e pela mesma razão: é uma
 * **exceção declarada por rota**, não um filtro de caminho. Rota nova nasce
 * bloqueada e só sai da trava quem escrever isto de propósito — filtro por
 * prefixo liberaria, sem querer, a próxima rota que começasse com o mesmo
 * caminho.
 *
 * **Sem "ler os textos" nesta lista a pessoa ficaria presa**: bloqueada por
 * não ter aceitado, e sem como ler o que precisa aceitar.
 */
export const PermiteAceitePendente = () =>
  SetMetadata(PERMITE_ACEITE_PENDENTE, true);

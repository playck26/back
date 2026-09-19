import { createHash } from 'crypto';

/**
 * SPEC-062/D2b, INV-062f — **como uma assinatura aparece no log.**
 *
 * `endpoint`, `p256dh` e `auth` são CREDENCIAL: quem os tiver pode mandar push
 * naquele aparelho. A MDN diz, com todas as letras, que o `endpoint` deve ser
 * mantido secreto — e a v1 desta spec protegia o corpo do aviso e a chave
 * privada, deixando os três no meio do caminho (achado 06 da 1ª rodada de
 * validação).
 *
 * **Uma função só, e não duas.** Duas viram uma com `console.log` do lado: a
 * segunda nasce "temporária, só para depurar", e é a que fica. Toda vez que o
 * módulo de push precisa dizer DE QUAL assinatura está falando, é por aqui.
 *
 * Oito caracteres do SHA-256 não revertem um `endpoint` de alta entropia, e
 * colisão aqui atrapalha diagnóstico, não autorização — ninguém decide nada
 * com base na impressão.
 */
export function impressaoDaAssinatura(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
}

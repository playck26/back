/**
 * SPEC-083/D8 — a higiene do que vem de pessoa e vai para um e-mail.
 *
 * Nome de clube e nome de aluno são digitados por gestor e chegam por
 * planilha. No HTML, um `"><a href=...>` vira link de verdade dentro de um
 * e-mail que sai com o nome do PlayCK; num cabeçalho, uma quebra de linha
 * tenta virar outro cabeçalho (`\r\nBcc:`). Cada destino tem a sua defesa, e
 * as três ficam aqui (AC-028).
 */

const ENTIDADES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * **Todo valor de pessoa passa por aqui antes de entrar no HTML** (D8). As
 * aspas simples e duplas entram junto porque o mesmo texto pode cair dentro
 * de um atributo, e escapar só `<` e `>` deixaria o atributo ser fechado.
 */
export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => ENTIDADES[caractere]);
}

/**
 * Controles C0 e C1, DEL e os separadores de linha e parágrafo do Unicode.
 * Os dois últimos não são controle, mas há cliente de e-mail que os desenha
 * como quebra de linha.
 */
// eslint-disable-next-line no-control-regex -- é exatamente o que se quer achar
const CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Para texto que tem de ficar numa linha só (assunto, nome de exibição) e para
 * a versão em texto puro: controle vira espaço, espaços seguidos viram um.
 */
export function linhaUnica(texto: string): string {
  return texto.replace(CONTROLE, ' ').replace(/\s+/g, ' ').trim();
}

/** D8 — o teto do nome do clube no remetente. */
export const LIMITE_DO_NOME_NO_REMETENTE = 60;

/**
 * D8 — o nome do clube **higienizado** para `"<clube> via PlayCK" <...>`: sem
 * `"`, `<`, `>`, `\`, CR, LF nem controle, até 60 caracteres, e vazio vira
 * `PlayCK`.
 *
 * Tirar, e não escapar: dentro de um nome de exibição entre aspas, `\"` é
 * escape válido pela RFC 5322, e é justamente o que um nome hostil usaria para
 * fechar as aspas. Sem `"` e sem `\`, não há como sair delas; sem `<` e `>`,
 * não há como fingir um segundo endereço.
 *
 * O corte é por ponto de código (`Array.from`), para não partir um emoji ao
 * meio e mandar meio caractere no cabeçalho.
 */
export function nomeDoClubeNoRemetente(nome: string): string {
  const limpo = linhaUnica(nome.replace(/["<>\\]/g, ''));
  const cortado = Array.from(limpo)
    .slice(0, LIMITE_DO_NOME_NO_REMETENTE)
    .join('')
    .trim();
  return cortado === '' ? 'PlayCK' : cortado;
}

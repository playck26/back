/**
 * SPEC-038/TASK-001 — **o analisador de CSV, e só ele.**
 *
 * ## Por que escrever em vez de instalar
 *
 * O item 1 do backlog pede "CSV/XLSX", e entregar `.xlsx` custaria uma
 * dependência nova para **analisar arquivo binário vindo da internet**: ZIP,
 * XML, fórmulas, links externos. O histórico de CVEs dessas bibliotecas inclui
 * poluição de protótipo e ReDoS, e a entrada aqui é um upload de terceiro.
 *
 * CSV não tem nada disso. O que ele tem de não-óbvio cabe nesta função, e está
 * todo coberto por teste:
 *
 * | Caso | Por que existe |
 * |---|---|
 * | `"a,b"` | vírgula **dentro** do campo — o motivo das aspas existirem |
 * | `"ele disse ""oi"""` | aspas escapadas dobrando |
 * | `"linha 1\nlinha 2"` | quebra de linha dentro do campo |
 * | `\r\n` | o Excel do Windows sempre grava assim |
 * | `\uFEFF` no começo | **o BOM**, que o Excel põe e ninguém vê |
 *
 * **O BOM é o mais traiçoeiro dos cinco.** Sem removê-lo, a primeira coluna do
 * cabeçalho se chama `\uFEFFnome` e nunca casa com `nome` — a planilha inteira
 * é recusada com "coluna desconhecida" apontando para uma coluna que, na tela
 * do gestor, está escrita certa.
 *
 * ## O que este módulo NÃO faz
 *
 * Não conhece aluno, coluna obrigatória nem validação. Ele transforma texto em
 * `string[][]`, e para aí. Quem dá significado é a `importacao-de-alunos`, e a
 * separação é o que torna a tabela-verdade acima testável sem banco.
 */

/** Uma linha do arquivo, já com os campos separados. */
export type LinhaDeCsv = string[];

/**
 * `\r\n`, `\n` e `\r` são todos fim de linha; **fora das aspas**.
 *
 * A varredura é caractere a caractere de propósito. Um `split(',')` com
 * remendos para aspas é o caminho que parece mais curto e quebra no primeiro
 * campo com vírgula dentro — que é justamente o caso que as aspas existem para
 * resolver.
 */
export function analisarCsv(texto: string): LinhaDeCsv[] {
  // **O BOM sai aqui, uma vez.** Removê-lo campo a campo depois deixaria
  // passar o caso em que a primeira coluna está entre aspas.
  const conteudo = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;

  const linhas: LinhaDeCsv[] = [];
  let campos: string[] = [];
  let campo = '';
  let dentroDeAspas = false;
  let i = 0;

  const fecharCampo = () => {
    campos.push(campo);
    campo = '';
  };
  const fecharLinha = () => {
    fecharCampo();
    linhas.push(campos);
    campos = [];
  };

  while (i < conteudo.length) {
    const c = conteudo[i];

    if (dentroDeAspas) {
      if (c === '"') {
        // `""` dentro de aspas é uma aspa literal. Só o segundo `"` seguido
        // de outra coisa fecha o campo.
        if (conteudo[i + 1] === '"') {
          campo += '"';
          i += 2;
          continue;
        }
        dentroDeAspas = false;
        i += 1;
        continue;
      }
      campo += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      dentroDeAspas = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      fecharCampo();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      fecharLinha();
      // `\r\n` conta como UM fim de linha. Sem este salto, todo arquivo do
      // Excel teria uma linha vazia entre cada duas de verdade.
      i += c === '\r' && conteudo[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    campo += c;
    i += 1;
  }

  // A última linha só entra se houver algo nela: um arquivo que termina com
  // quebra de linha — que é o normal — não ganha uma linha vazia no fim.
  if (campo !== '' || campos.length > 0) {
    fecharLinha();
  }

  return linhas;
}

/**
 * Linhas em branco somem, e o **número da linha original** é preservado.
 *
 * O relatório de erro cita a linha **da planilha**, contando o cabeçalho —
 * é ela que o gestor vê no Excel. Renumerar depois de filtrar faria a
 * mensagem apontar para a linha errada, e ele procuraria o problema no lugar
 * errado.
 */
export function linhasComNumero(
  texto: string,
): { numero: number; campos: LinhaDeCsv }[] {
  return analisarCsv(texto)
    .map((campos, indice) => ({ numero: indice + 1, campos }))
    .filter(({ campos }) => campos.some((c) => c.trim() !== ''));
}

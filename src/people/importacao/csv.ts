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
 * ## O separador vem do arquivo (SPEC-083/D2)
 *
 * O Excel em português grava CSV com `;`, porque o separador de lista do
 * Windows em `pt-BR` é `;`. Com um analisador só de vírgula, o cabeçalho
 * inteiro virava **uma** coluna desconhecida, e a planilha que o próprio gestor
 * acabou de salvar era recusada. O `detectarSeparador` decide pela primeira
 * linha, e o resto do arquivo obedece.
 *
 * ## O que este módulo NÃO faz
 *
 * Não conhece aluno, coluna obrigatória nem validação. Ele transforma texto em
 * `string[][]`, e para aí. Quem dá significado é a `importacao-de-alunos`, e a
 * separação é o que torna a tabela-verdade acima testável sem banco.
 */

/** Uma linha do arquivo, já com os campos separados. */
export type LinhaDeCsv = string[];

/** Os dois separadores que uma planilha de verdade usa (SPEC-083/D2). */
export type Separador = ',' | ';';

/** **O BOM sai aqui, uma vez.** Removê-lo campo a campo depois deixaria passar
 *  o caso em que a primeira coluna está entre aspas. */
function semBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/**
 * SPEC-083/D2 — **o separador é decidido só pela primeira linha**: conta `;` e
 * `,` fora de aspas, e ganha o que aparecer mais. Empate ou nenhum vale `,`,
 * que era o único separador antes desta spec.
 *
 * *Por que só a primeira linha:* o cabeçalho é a única linha cujo conteúdo a
 * importação conhece. Uma linha de dados pode ter vírgula num nome
 * (`Souza, Ana`) ou ponto e vírgula num campo livre; deixar os dados votarem
 * faria um nome mudar o separador do arquivo inteiro.
 *
 * As aspas valem aqui também: `"nome;completo",email` é um cabeçalho de
 * vírgula, e o `;` entre aspas não conta. Uma quebra de linha entre aspas
 * também não encerra a primeira linha, pela mesma regra do analisador.
 */
export function detectarSeparador(texto: string): Separador {
  const conteudo = semBom(texto);
  let pontoEVirgula = 0;
  let virgula = 0;
  let dentroDeAspas = false;

  for (const c of conteudo) {
    // `""` dentro de aspas alterna duas vezes e volta para dentro — o mesmo
    // efeito da aspa literal no analisador, sem precisar olhar adiante.
    if (c === '"') {
      dentroDeAspas = !dentroDeAspas;
      continue;
    }
    if (dentroDeAspas) continue;
    if (c === '\r' || c === '\n') break;
    if (c === ';') pontoEVirgula += 1;
    if (c === ',') virgula += 1;
  }

  return pontoEVirgula > virgula ? ';' : ',';
}

/**
 * `\r\n`, `\n` e `\r` são todos fim de linha; **fora das aspas**.
 *
 * A varredura é caractere a caractere de propósito. Um `split(',')` com
 * remendos para aspas é o caminho que parece mais curto e quebra no primeiro
 * campo com vírgula dentro — que é justamente o caso que as aspas existem para
 * resolver.
 *
 * **O separador é parâmetro, e não detecção feita aqui dentro** (SPEC-083/D2):
 * quem chama decide uma vez, pelo cabeçalho, e todas as linhas usam o mesmo.
 * O outro caractere é texto comum do campo, com ou sem aspas.
 */
export function analisarCsv(texto: string, separador: Separador): LinhaDeCsv[] {
  const conteudo = semBom(texto);

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
    if (c === separador) {
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
 *
 * É aqui que o separador é decidido, uma vez, pelo cabeçalho (SPEC-083/D2).
 */
export function linhasComNumero(
  texto: string,
): { numero: number; campos: LinhaDeCsv }[] {
  return analisarCsv(texto, detectarSeparador(texto))
    .map((campos, indice) => ({ numero: indice + 1, campos }))
    .filter(({ campos }) => campos.some((c) => c.trim() !== ''));
}

/**
 * SPEC-076/AC-030 — o corpo do portão (`travarEValidarOcorrencia`) escrito
 * numa **gramática fechada**, conferida pela AST do próprio TypeScript.
 *
 * A 6ª rodada de validação atravessou a lista de chamadas da 5ª com uma
 * chamada computada — `agora['setTime'](globalThis['Date']['now']())` — que o
 * léxico artesanal não via. Buscar formas de chamada é a mesma busca sem fim
 * das rodadas anteriores. O que fecha é o inverso: descrever o que o corpo
 * PODE conter, pelo parser da linguagem, e recusar o resto.
 *
 * `inventarioDoCorpo` devolve, do corpo do método, pela AST:
 * - os **identificadores livres** (o que o corpo alcança pelo nome: global,
 *   import, parâmetro) — sem `globalThis`, `Date`, `Reflect`, `eval`,
 *   `require`, nenhum relógio é alcançável pelo nome;
 * - os **nomes de propriedade** (`a.b`) — sem `constructor`, `now`,
 *   `setTime`, `call`, nenhum relógio é alcançável a partir de um objeto;
 * - os **acessos por colchete** (`a[b]`), por extenso;
 * - os **tipos de nó** sintáticos — sem função, classe, `import()`, `delete`,
 *   `with`, não há onde esconder código;
 * - os **operadores** — sem atribuição, nada é trocado no lugar;
 * - as chamadas, e o SQL de cada `tx.$queryRaw`.
 *
 * O db-spec compara cada um com uma lista EXATA. Os tipos (anotações e
 * argumentos genéricos) ficam fora: não executam.
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

export interface Inventario {
  livres: string[];
  propriedades: string[];
  colchetes: string[];
  tiposDeNo: string[];
  operadores: string[];
  chamadas: string[];
  sql: string[];
}

const ordenado = (s: Set<string>) => [...s].sort();

const lerFonte = (arquivo: string) =>
  ts.createSourceFile(
    arquivo,
    readFileSync(arquivo, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

export function inventarioDoCorpo(arquivo: string, metodo: string): Inventario {
  const fonte = lerFonte(arquivo);
  let alvo: ts.MethodDeclaration | undefined;
  const achar = (n: ts.Node) => {
    if (
      ts.isMethodDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === metodo
    ) {
      alvo = n;
    }
    ts.forEachChild(n, achar);
  };
  achar(fonte);
  if (!alvo?.body) throw new Error(`método ${metodo} não achado`);
  return inventario(fonte, alvo.body);
}

/**
 * O mesmo inventário para o INICIALIZADOR de uma constante de módulo que o
 * corpo lê (a tabela de recusas): ela também não pode esconder código.
 */
export function inventarioDaConstante(
  arquivo: string,
  nome: string,
): Inventario {
  const fonte = lerFonte(arquivo);
  let alvo: ts.Expression | undefined;
  const achar = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === nome &&
      n.initializer
    ) {
      alvo = n.initializer;
    }
    ts.forEachChild(n, achar);
  };
  achar(fonte);
  if (!alvo) throw new Error(`constante ${nome} não achada`);
  return inventario(fonte, alvo);
}

function inventario(fonte: ts.SourceFile, corpo: ts.Node): Inventario {
  // 1ª passada: o que o corpo DECLARA (não é livre).
  const locais = new Set<string>();
  const declarar = (nome: ts.BindingName) => {
    if (ts.isIdentifier(nome)) locais.add(nome.text);
    else
      for (const e of nome.elements)
        if (!ts.isOmittedExpression(e)) declarar(e.name);
  };
  const acharDeclaracoes = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n)) declarar(n.name);
    ts.forEachChild(n, acharDeclaracoes);
  };
  acharDeclaracoes(corpo);

  const livres = new Set<string>();
  const propriedades = new Set<string>();
  const colchetes: string[] = [];
  const tiposDeNo = new Set<string>();
  const operadores = new Set<string>();
  const chamadas: string[] = [];
  const sql: string[] = [];
  const texto = (n: ts.Node) => n.getText(fonte).replace(/\s+/g, ' ');

  const visitar = (n: ts.Node) => {
    // Tipo não executa: anotação, genérico, `as`, `satisfies` ficam fora.
    if (ts.isTypeNode(n)) return;
    tiposDeNo.add(ts.SyntaxKind[n.kind]);
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === n)
        propriedades.add(n.text);
      else if (ts.isPropertyAssignment(p) && p.name === n) {
        // chave de objeto literal: não é leitura
      } else if (
        (ts.isVariableDeclaration(p) || ts.isBindingElement(p)) &&
        p.name === n
      ) {
        // declaração local
      } else if (!locais.has(n.text)) livres.add(n.text);
    }
    if (ts.isElementAccessExpression(n)) colchetes.push(texto(n));
    if (ts.isBinaryExpression(n))
      operadores.add(ts.tokenToString(n.operatorToken.kind) ?? '?');
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      operadores.add(`unário ${ts.tokenToString(n.operator) ?? '?'}`);
    }
    if (ts.isCallExpression(n)) chamadas.push(`${texto(n.expression)}(`);
    if (ts.isNewExpression(n)) chamadas.push(`new ${texto(n.expression)}(`);
    if (ts.isTaggedTemplateExpression(n)) {
      chamadas.push(`${texto(n.tag)}\``);
      const t = n.template;
      const partes = ts.isNoSubstitutionTemplateLiteral(t)
        ? [t.text]
        : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)];
      sql.push(partes.join('$').replace(/\s+/g, ' ').trim());
    }
    ts.forEachChild(n, visitar);
  };
  ts.forEachChild(corpo, visitar);

  return {
    livres: ordenado(livres),
    propriedades: ordenado(propriedades),
    colchetes,
    tiposDeNo: ordenado(tiposDeNo),
    operadores: ordenado(operadores),
    chamadas,
    sql,
  };
}

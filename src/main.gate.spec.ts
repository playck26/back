import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * **SPEC-071/AC-006 — o `main.ts` não carrega lógica, e isso é por AST.**
 *
 * A fresta que sobra depois que o `bootstrap()` virou módulo executável são
 * **duas instruções**. Elas ficam cobertas por texto, não por execução — e é
 * pequeno o bastante para uma revisão humana, que o corpo inteiro não era.
 *
 * **Por que AST e não comparação de bytes:** a 8ª rodada de validação pediu
 * isso com todas as letras. Um gate literal ficaria vermelho por um comentário
 * novo ou por uma quebra de linha do Prettier — falso positivo, e *falso
 * positivo ensina a ignorar a ferramenta*. O que importa é a **estrutura**:
 *
 * 1. um import **nomeado** de `bootstrap`, vindo de `./bootstrap`;
 * 2. a expressão `void bootstrap()`;
 * 3. **nenhum terceiro statement e nenhum import lateral** — `import './algo'`
 *    executa o módulo só por ser carregado, e por isso é o caso que o gate
 *    precisa pegar.
 */
export function violacoesDoMain(fonte: string): string[] {
  const arquivo = ts.createSourceFile(
    'main.ts',
    fonte,
    ts.ScriptTarget.ES2023,
    true,
  );
  const problemas: string[] = [];
  const statements = arquivo.statements;

  if (statements.length !== 2) {
    problemas.push(
      `esperava 2 statements, achei ${statements.length}: ` +
        statements.map((s) => ts.SyntaxKind[s.kind]).join(', '),
    );
    return problemas;
  }

  const [primeiro, segundo] = statements;

  if (!ts.isImportDeclaration(primeiro)) {
    problemas.push(`o 1o statement é ${ts.SyntaxKind[primeiro.kind]}`);
  } else {
    const de = (primeiro.moduleSpecifier as ts.StringLiteral).text;
    if (de !== './bootstrap') {
      problemas.push(`importa de ${de}`);
    }
    const bindings = primeiro.importClause?.namedBindings;
    if (!bindings) {
      // `import './bootstrap'` — carga por efeito, sem nome. O gate existe
      // principalmente para este caso.
      problemas.push('import LATERAL: sem nome importado');
    } else if (!ts.isNamedImports(bindings)) {
      problemas.push('import não é nomeado');
    } else {
      const nomes = bindings.elements.map((e) => e.name.getText());
      if (JSON.stringify(nomes) !== JSON.stringify(['bootstrap'])) {
        problemas.push(`importa ${nomes.join(', ')}`);
      }
    }
  }

  if (!ts.isExpressionStatement(segundo)) {
    problemas.push(`o 2o statement é ${ts.SyntaxKind[segundo.kind]}`);
  } else {
    const expr = segundo.expression;
    const chamada =
      ts.isVoidExpression(expr) && ts.isCallExpression(expr.expression)
        ? expr.expression
        : undefined;
    if (!chamada) {
      problemas.push('o 2o statement não é `void <chamada>()`');
    } else if (chamada.expression.getText() !== 'bootstrap') {
      problemas.push(`chama ${chamada.expression.getText()}`);
    } else if (chamada.arguments.length !== 0) {
      problemas.push('a chamada recebe argumento');
    }
  }

  return problemas;
}

const FONTE_REAL = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');

describe('o `main.ts` tem duas instruções, e só elas', () => {
  it('o arquivo de verdade não tem violação', () => {
    expect(violacoesDoMain(FONTE_REAL)).toEqual([]);
  });

  // **O caso que motiva o gate.** Um import lateral executa o módulo pela
  // carga — não passa por dublê nenhum e não aparece em log nenhum.
  it('um import LATERAL fica vermelho', () => {
    const sabotado = `import './algo';\n${FONTE_REAL}`;
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado).join(' ')).toContain('esperava 2');
  });

  it('um terceiro statement fica vermelho', () => {
    const sabotado = `${FONTE_REAL}\nconsole.log('oi');\n`;
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado).join(' ')).toContain('esperava 2');
  });

  it('trocar o alvo da chamada fica vermelho', () => {
    const sabotado = FONTE_REAL.replace('void bootstrap()', 'void outra()');
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado).join(' ')).toContain('chama outra');
  });

  it('trocar o import por lateral fica vermelho', () => {
    const sabotado = FONTE_REAL.replace(
      "import { bootstrap } from './bootstrap';",
      "import './bootstrap';",
    );
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado).join(' ')).toContain('LATERAL');
  });

  // **Estes dois TÊM de passar**, e é a diferença entre AST e bytes.
  it('um comentário a mais continua VERDE', () => {
    const sabotado = `// uma nota qualquer\n${FONTE_REAL}`;
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado)).toEqual([]);
  });

  it('reformatar continua VERDE', () => {
    const sabotado = FONTE_REAL.replace(
      'void bootstrap();',
      'void bootstrap(\n);',
    );
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoMain(sabotado)).toEqual([]);
  });
});

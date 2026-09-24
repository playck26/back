import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { bootstrap } from './bootstrap';

/**
 * **SPEC-071/TASK-002 — os DOIS observadores, e nenhum é completo sozinho.**
 *
 * O `bootstrap()` não era executado por teste nenhum, e três sabotagens
 * atravessaram as tentativas anteriores de fechar isso. A lição que sobrou de
 * quatro rodadas de validação:
 *
 * > **Um observador dinâmico fecha sobre o que passa por ele, e nunca sobre o
 * > que não passa.** Não existe lista de objetos a dublar que esgote os efeitos
 * > de um corpo de função. O que esgota é olhar o arquivo.
 *
 * | Observador | Universo | O que NÃO alcança |
 * |---|---|---|
 * | log dinâmico | chamadas que atravessam `app` e `SwaggerModule` | `process.on`, `process.env`, efeito de import, DI |
 * | allowlist AST | **todo statement de `bootstrap.ts`** | outros módulos e a camada de DI |
 *
 * O que escapa de um é o que o outro pega. **A spec declara os dois limites em
 * vez de prometer um "completo" que não existe.**
 */

// ---------------------------------------------------------------------------
// O log dinâmico
// ---------------------------------------------------------------------------

interface Chamada {
  nome: string;
  args: unknown[];
}

const chamadas: Chamada[] = [];

/**
 * **O dublê não cura a lista: ele registra TODA chamada que recebe.**
 *
 * É um `Proxy`, e não um objeto com métodos conhecidos, exatamente por isso —
 * `app.getHttpAdapter().getInstance().use(…)` não passa por `app.use`, e um
 * dublê com lista de métodos curada não veria nenhuma das três. Aqui as três
 * entram no log, e o multiconjunto fica diferente do declarado.
 *
 * `then` devolve `undefined` de propósito: sem isso o `await` de dentro de
 * `criarAppDeProducao` trataria o dublê como *thenable*.
 */
function appEspiao(): Record<string, unknown> {
  const espiao: Record<string, unknown> = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (typeof prop !== 'string' || prop === 'then') {
          return undefined;
        }
        return (...args: unknown[]) => {
          chamadas.push({ nome: prop, args });
          return espiao;
        };
      },
    },
  );
  return espiao;
}

jest.mock('@nestjs/core', () => ({
  ...jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core'),
  NestFactory: { create: jest.fn() },
}));

jest.mock('@nestjs/swagger', () => ({
  ...jest.requireActual<typeof import('@nestjs/swagger')>('@nestjs/swagger'),
  SwaggerModule: { createDocument: jest.fn(), setup: jest.fn() },
}));

const DOCUMENTO = { openapi: '3.0.0' };

describe('o log do bootstrap é fechado sobre `app` e `SwaggerModule`', () => {
  beforeAll(async () => {
    chamadas.length = 0;
    (NestFactory.create as jest.Mock).mockResolvedValue(appEspiao());
    (SwaggerModule.createDocument as jest.Mock).mockImplementation(
      (...args: unknown[]) => {
        chamadas.push({ nome: 'SwaggerModule.createDocument', args });
        return DOCUMENTO;
      },
    );
    (SwaggerModule.setup as jest.Mock).mockImplementation(
      (...args: unknown[]) => {
        chamadas.push({ nome: 'SwaggerModule.setup', args });
      },
    );
    await bootstrap();
  });

  // **O multiconjunto, e é ele que fecha.** Um `use` a mais, um `setup` a mais,
  // um `setup` a menos, ou o desvio pelo adaptador HTTP mudam esta lista.
  it('registra EXATAMENTE estas chamadas, e nenhuma outra', () => {
    const contagem = chamadas.reduce<Record<string, number>>((acc, c) => {
      acc[c.nome] = (acc[c.nome] ?? 0) + 1;
      return acc;
    }, {});
    expect(contagem).toEqual({
      setGlobalPrefix: 1,
      use: 2,
      useGlobalPipes: 1,
      enableCors: 1,
      'SwaggerModule.createDocument': 1,
      'SwaggerModule.setup': 1,
      listen: 1,
    });
  });

  // **Os argumentos são ENUMERADOS, e não "os relevantes".** A 8ª rodada
  // derrubou "argumentos relevantes" por ser frouxo demais: sem isto,
  // `enableCors` com o objeto errado passaria.
  it('com os argumentos que produção espera', () => {
    const chamada = (nome: string) => chamadas.find((c) => c.nome === nome);

    expect(chamada('setGlobalPrefix')?.args).toEqual(['api/v1']);

    const pipe = chamada('useGlobalPipes')?.args[0] as {
      validatorOptions?: Record<string, unknown>;
    };
    expect(pipe?.validatorOptions).toMatchObject({
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    // **O objeto INTEIRO, e nao uma propriedade.** A SPEC-070 acrescentou
    // `maxAge`, e a versao anterior desta assercao teria passado sem ele --
    // que foi o achado B07 daquela spec.
    expect(chamada('enableCors')?.args[0]).toEqual({
      origin: [
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:3003',
      ],
      credentials: true,
      maxAge: 600,
    });

    const setup = chamada('SwaggerModule.setup')?.args ?? [];
    expect(setup[0]).toBe('api/docs');
    expect(setup[2]).toBe(DOCUMENTO);

    expect(chamada('listen')?.args).toEqual([process.env.PORT ?? 3000]);
  });

  // **A ordem é PARCIAL**: afirmada só onde é semântica. Trocar
  // `useGlobalPipes` com `enableCors` não muda comportamento observável e
  // continua verde — a 6ª rodada mostrou que congelar a ordem total cria falso
  // positivo.
  it('e na ordem que é semântica, só nela', () => {
    const posicao = (nome: string) =>
      chamadas.findIndex((c) => c.nome === nome);
    const usos = chamadas
      .map((c, i) => (c.nome === 'use' ? i : -1))
      .filter((i) => i >= 0);

    expect(usos[0]).toBeLessThan(usos[1]);
    expect(posicao('SwaggerModule.createDocument')).toBeLessThan(
      posicao('SwaggerModule.setup'),
    );
    expect(posicao('listen')).toBe(chamadas.length - 1);
  });

  // **O limite deste observador, afirmado em vez de prometido.** Nenhum nome
  // registrado vem de fora dos dois dublês — e é exatamente por isso que
  // `process.on(…)` no `bootstrap.ts` ficaria VERDE aqui. Quem o pega é a
  // allowlist AST abaixo.
  it('e NÃO alcança efeito global: por isso existe a allowlist', () => {
    const deFora = chamadas.filter(
      (c) => !c.nome.startsWith('SwaggerModule.') && c.nome.includes('.'),
    );
    expect(deFora).toEqual([]);
    expect(chamadas.some((c) => c.nome.startsWith('process'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A allowlist AST do ARQUIVO
// ---------------------------------------------------------------------------

const IMPORTS_PERMITIDOS: Record<string, string[]> = {
  '@nestjs/swagger': ['SwaggerModule'],
  './common/validation/configurar-app': ['criarAppDeProducao'],
  './swagger.config': ['buildSwaggerConfig'],
};

// **SPEC-070/D4 encolheu esta lista de sete para quatro**, e a allowlist ficou
// VERMELHA antes de eu atualiza-la -- que e exatamente o que ela existe para
// fazer. Vermelho aqui nao e falso positivo: e "revise explicitamente o
// contrato de inicializacao". O bloco de CORS saiu do bootstrap e entrou em
// `criarAppDeProducao`, que tem prova de execucao propria.
const CORPO_PERMITIDO = [
  'const app',
  'const swaggerDocument',
  'SwaggerModule.setup',
  'app.listen',
];

function alvoDaChamada(no: ts.Node): string {
  let expr: ts.Node = no;
  while (ts.isAwaitExpression(expr) || ts.isVoidExpression(expr)) {
    expr = expr.expression;
  }
  if (ts.isCallExpression(expr)) {
    return expr.expression.getText();
  }
  return expr.getText().split('(')[0];
}

function rotuloDoStatement(stmt: ts.Statement): string {
  if (ts.isVariableStatement(stmt)) {
    const nomes = stmt.declarationList.declarations
      .map((d) => d.name.getText())
      .join(', ');
    return `const ${nomes}`;
  }
  if (ts.isExpressionStatement(stmt)) {
    return alvoDaChamada(stmt.expression);
  }
  return ts.SyntaxKind[stmt.kind];
}

/**
 * **A allowlist do arquivo inteiro, e não do corpo.**
 *
 * A primeira versão olhava só o corpo da função, e a 7ª rodada derrubou em duas
 * linhas: `process.on(…)` no **topo** do arquivo acontece ao importar, deixa o
 * corpo íntegro e passa em tudo. São quatro cláusulas, e a terceira é a que
 * fechou o furo.
 */
export function violacoesDoBootstrap(fonte: string): string[] {
  const arquivo = ts.createSourceFile(
    'bootstrap.ts',
    fonte,
    ts.ScriptTarget.ES2023,
    true,
  );
  const problemas: string[] = [];
  const exportadas: string[] = [];

  for (const stmt of arquivo.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const de = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const permitido = IMPORTS_PERMITIDOS[de];
      if (!permitido) {
        problemas.push(`import não enumerado: ${de}`);
        continue;
      }
      const clausula = stmt.importClause;
      if (!clausula || !clausula.namedBindings) {
        // `import './algo'` — efeito de carga sem nome nenhum.
        problemas.push(`import LATERAL: ${de}`);
        continue;
      }
      const nomes = ts.isNamedImports(clausula.namedBindings)
        ? clausula.namedBindings.elements.map((e) => e.name.getText())
        : [clausula.namedBindings.getText()];
      if (JSON.stringify(nomes) !== JSON.stringify(permitido)) {
        problemas.push(`import ${de} traz ${nomes.join(', ')}`);
      }
      continue;
    }

    if (ts.isFunctionDeclaration(stmt)) {
      exportadas.push(stmt.name?.getText() ?? '(anônima)');
      const corpo = (stmt.body?.statements ?? []).map(rotuloDoStatement);
      if (JSON.stringify(corpo) !== JSON.stringify(CORPO_PERMITIDO)) {
        problemas.push(`corpo diferente do declarado: ${corpo.join(' | ')}`);
      }
      continue;
    }

    // Terceira cláusula: nada executável no nível superior. `process.on(…)`,
    // `process.env.X = …`, uma IIFE, um `try` de topo — tudo cai aqui.
    problemas.push(
      `statement no NÍVEL SUPERIOR: ${ts.SyntaxKind[stmt.kind]} — ` +
        stmt.getText().split('\n')[0].slice(0, 60),
    );
  }

  if (JSON.stringify(exportadas) !== JSON.stringify(['bootstrap'])) {
    problemas.push(`declarações: ${exportadas.join(', ') || 'nenhuma'}`);
  }
  return problemas;
}

const FONTE_REAL = fs.readFileSync(
  path.join(__dirname, 'bootstrap.ts'),
  'utf8',
);

describe('o ARQUIVO `bootstrap.ts` é fechado', () => {
  it('o arquivo de verdade não tem violação', () => {
    expect(violacoesDoBootstrap(FONTE_REAL)).toEqual([]);
  });

  // **As quatro sabotagens do B17/B21**, nas DUAS posições. As duas de topo
  // são o B21: na versão que olhava só o corpo, ficavam verdes nos dois
  // observadores.
  it.each([
    ['no corpo', 'process.on', 'const app = await criarAppDeProducao();'],
    ['no corpo', 'process.env', 'const app = await criarAppDeProducao();'],
  ])('efeito global %s (%s) fica vermelho', (_onde, efeito) => {
    const linha =
      efeito === 'process.on'
        ? "process.on('uncaughtException', () => {});"
        : "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';";
    const sabotado = FONTE_REAL.replace(
      '  const app = await criarAppDeProducao();',
      `  ${linha}\n  const app = await criarAppDeProducao();`,
    );
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoBootstrap(sabotado)).not.toEqual([]);
  });

  it.each([
    ["process.on('uncaughtException', () => {});"],
    ["process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"],
  ])('efeito global NO TOPO do arquivo fica vermelho: %s', (linha) => {
    const sabotado = FONTE_REAL.replace(
      'export async function bootstrap',
      `${linha}\n\nexport async function bootstrap`,
    );
    expect(sabotado).not.toBe(FONTE_REAL);
    const violacoes = violacoesDoBootstrap(sabotado);
    expect(violacoes.join(' ')).toContain('NÍVEL SUPERIOR');
  });

  it('import lateral fica vermelho', () => {
    const sabotado = `import './algo';\n${FONTE_REAL}`;
    expect(violacoesDoBootstrap(sabotado).join(' ')).toContain('não enumerado');
  });

  it('uma segunda declaração exportada fica vermelha', () => {
    const sabotado = `${FONTE_REAL}\nexport function outra(): void {}\n`;
    expect(violacoesDoBootstrap(sabotado).join(' ')).toContain('declarações');
  });

  it('um statement a mais no corpo fica vermelho', () => {
    const sabotado = FONTE_REAL.replace(
      '  await app.listen(',
      '  const x = 1;\n  await app.listen(',
    );
    expect(sabotado).not.toBe(FONTE_REAL);
    expect(violacoesDoBootstrap(sabotado).join(' ')).toContain('corpo');
  });

  // `LIM-071h`: enquanto o corpo for curto, vermelho aqui quer dizer "revise o
  // contrato de inicialização". Passando de dez, a allowlist dá lugar a função
  // extraída e testável — e este teste é o gatilho.
  it('e o corpo continua curto o bastante para a allowlist se justificar', () => {
    expect(CORPO_PERMITIDO.length).toBeLessThanOrEqual(10);
  });
});

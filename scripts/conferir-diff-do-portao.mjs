#!/usr/bin/env node
/**
 * SPEC-081/AC-009 — **nenhuma expectativa dos testes do guard foi
 * enfraquecida.** Lista de alterações PERMITIDAS, não de palavras proibidas.
 *
 * Compara a árvore de trabalho com uma base (padrão `main`), pelo
 * `git diff -U0` e pela árvore sintática do TypeScript, e reprova (exit 1) se:
 *
 *  R1  o conjunto de identidades de casos mudar em `jwt-auth.guard.spec.ts`
 *      ou em qualquer um dos 30 e2e (23 do dublê compartilhado + 7 de dublê
 *      próprio). Caso = chamada cuja RAIZ é `it`/`test`, em qualquer forma;
 *      identidade = títulos dos `describe` + título + tabela do `.each`.
 *  R2  houver linha alterada nos 22 do dublê compartilhado que não são
 *      `test/auth.e2e-spec.ts`.
 *  R3  em `test/auth.e2e-spec.ts`, um caso PROTEGIDO (o da base cujo texto tem
 *      `.expect(403)` ou um dos quatro códigos) ou uma declaração fora de caso
 *      que ele referencia não tiver texto idêntico.
 *  R4  num dos 7 de dublê próprio, a árvore diferir da base em algo além da
 *      forma exata: um `import { comPortaoDoUsuario } from
 *      './utils/portao-no-duble'` e UMA chamada `comPortaoDoUsuario(<id>)` no
 *      `useValue` do provider de `PrismaService`.
 *  R5  em `test/utils/prisma-mock.ts`, a árvore diferir da base em algo além
 *      de `import { comPortaoDoUsuario } from './portao-no-duble'` e UMA
 *      chamada `comPortaoDoUsuario(<id>)` no `return` de `buildPrismaMock`.
 *  R6  houver diff em qualquer arquivo de `test/utils/` alcançado pelos
 *      imports (resolvidos pelo TypeScript) dos 30 e2e e do teste do guard,
 *      fora das exceções `portao-no-duble.ts` e `prisma-mock.ts`.
 *  R7  em `jwt-auth.guard.spec.ts`, linha alterada fora da allowlist (linhas
 *      com `findUnique`, `$queryRaw`, `mockResolvedValue`, `mockReturnValue`,
 *      `jest.fn`, ou a asserção de mecanismo da antiga linha 71).
 *
 *      `--r7=forma` troca a R7 pela PROPOSTA de emenda (não aprovada na
 *      v7 da spec): a mesma forma exata da R4/R5 — um `import {
 *      comPortaoDoUsuario }` e UMA chamada `comPortaoDoUsuario({…})` como
 *      corpo de cada um dos quatro montadores do dublê. O padrão é a R7 da
 *      norma aprovada (`--r7=linhas`).
 *
 * Uso: node scripts/conferir-diff-do-portao.mjs [--base <ref>] [--r7=linhas|forma]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const RAIZ = process.cwd();
const argBase = process.argv.indexOf('--base');
const BASE = argBase > 0 ? process.argv[argBase + 1] : 'main';
const R7_FORMA = process.argv.includes('--r7=forma');
const MONTADORES_DO_GUARD = [
  'buildPrisma',
  'prismaInativo',
  'prismaEmpresaInativa',
  'prisma',
];

const GUARD_SPEC = 'src/common/guards/jwt-auth.guard.spec.ts';
const AUTH_E2E = 'test/auth.e2e-spec.ts';
const PRISMA_MOCK = 'test/utils/prisma-mock.ts';
const HELPER = 'test/utils/portao-no-duble.ts';
const PROPRIOS = [
  'classes',
  'classes-eventos',
  'company-logo',
  'court-catalogs',
  'fit-007',
  'me-foto',
  'media-da-turma-por-papel',
].map((n) => `test/${n}.e2e-spec.ts`);
const CODIGOS = [
  'CONTA_INATIVA',
  'EMPRESA_INATIVA',
  'SENHA_TEMPORARIA',
  'ACEITE_PENDENTE',
];
const ALLOWLIST_GUARD = [
  'findUnique',
  '$queryRaw',
  'mockResolvedValue',
  'mockReturnValue',
  'jest.fn',
];
const LINHA_71 = 'expect(prisma.usuario.findUnique).toHaveBeenCalled();';

const git = (...args) =>
  execFileSync('git', args, {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

function naBase(arquivo) {
  try {
    return git('show', `${BASE}:${arquivo}`).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}
function naArvore(arquivo) {
  const p = path.join(RAIZ, arquivo);
  return existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
}
const parse = (arquivo, texto) =>
  ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true);

/** Linhas alteradas (+ e −) do `git diff -U0` contra a base. */
function linhasAlteradas(arquivo) {
  const saida = git(
    '-c',
    'core.autocrlf=false',
    'diff',
    '-U0',
    '--ignore-cr-at-eol',
    BASE,
    '--',
    arquivo,
  );
  return saida
    .split('\n')
    .filter(
      (l) =>
        (l.startsWith('+') || l.startsWith('-')) &&
        !l.startsWith('+++') &&
        !l.startsWith('---'),
    );
}

// ---------------------------------------------------------------- casos
function raiz(expr) {
  let e = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e))
      e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) ? e.text : null;
}
/** A chamada mais externa de uma cadeia (`it.each(t)(…)`, não `it.each(t)`). */
const ehExterna = (n) =>
  !(n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n);

/** Título de um nó de `describe`/caso: o 1º argumento, mais a tabela do `.each`. */
function rotulo(chamada, sf) {
  const titulo = chamada.arguments[0]?.getText(sf) ?? '<sem título>';
  const interna = ts.isCallExpression(chamada.expression)
    ? chamada.expression
    : null;
  const tabela = interna ? interna.arguments.map((a) => a.getText(sf)).join(',') : '';
  return tabela ? `${titulo} ⟨each: ${tabela}⟩` : titulo;
}

function casos(sf) {
  const lista = [];
  const visitar = (n) => {
    if (ts.isCallExpression(n) && ehExterna(n)) {
      const r = raiz(n.expression);
      if (r === 'it' || r === 'test') {
        const caminho = [];
        for (let p = n.parent; p; p = p.parent) {
          if (ts.isCallExpression(p) && ehExterna(p) && raiz(p.expression) === 'describe') {
            caminho.unshift(rotulo(p, sf));
          }
        }
        lista.push({
          id: [...caminho, rotulo(n, sf)].join(' › '),
          no: n,
          texto: n.getText(sf),
        });
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return lista;
}

const multiconjunto = (ids) => {
  const m = new Map();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
};
function diferencaDeCasos(base, head) {
  const a = multiconjunto(base.map((c) => c.id));
  const b = multiconjunto(head.map((c) => c.id));
  const falta = [...a].filter(([k, v]) => (b.get(k) ?? 0) < v).map(([k]) => k);
  const sobra = [...b].filter(([k, v]) => (a.get(k) ?? 0) < v).map(([k]) => k);
  return { falta, sobra };
}

// ------------------------------------------------------- forma exata (R4/R5)
const impressora = ts.createPrinter({ removeComments: true });
const imprimir = (sf) => impressora.printFile(sf);

/**
 * Tira do arquivo da branch a forma admitida e devolve o texto normalizado,
 * ou a lista de motivos por que a forma não é a admitida.
 */
function normalizarForma(arquivo, texto, modulo, lugarValido, esperadas = 1, argumentoDeObjeto = false) {
  const sf = parse(arquivo, texto);
  const motivos = [];
  const imports = sf.statements.filter(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === modulo,
  );
  const chamadas = [];
  const visitar = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'comPortaoDoUsuario'
    ) {
      chamadas.push(n);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  if (imports.length !== 1) motivos.push(`${imports.length} imports de ${modulo} (esperado 1)`);
  else {
    const c = imports[0].importClause;
    const nomes = c?.namedBindings;
    const ok =
      c &&
      !c.name &&
      !c.isTypeOnly &&
      nomes &&
      ts.isNamedImports(nomes) &&
      nomes.elements.length === 1 &&
      !nomes.elements[0].propertyName &&
      !nomes.elements[0].isTypeOnly &&
      nomes.elements[0].name.text === 'comPortaoDoUsuario';
    if (!ok) motivos.push(`o import de ${modulo} não é "{ comPortaoDoUsuario }"`);
  }
  if (chamadas.length !== esperadas)
    motivos.push(`${chamadas.length} chamadas de comPortaoDoUsuario (esperado ${esperadas})`);
  else {
    for (const ch of chamadas) {
      const arg = ch.arguments[0];
      const formaDoArgumento = argumentoDeObjeto
        ? arg && ts.isObjectLiteralExpression(arg)
        : arg && ts.isIdentifier(arg);
      if (ch.arguments.length !== 1 || !formaDoArgumento)
        motivos.push(
          `a chamada não tem exatamente um ${argumentoDeObjeto ? 'objeto literal' : 'identificador'} como argumento`,
        );
      else if (!lugarValido(ch)) motivos.push('a chamada não está no ponto admitido');
    }
    const lugares = new Set(chamadas.map((ch) => lugarValido(ch)));
    if (esperadas > 1 && lugares.size !== esperadas)
      motivos.push('duas chamadas no mesmo lugar');
  }
  if (motivos.length) return { motivos };

  // Remove o import e troca cada chamada pelo seu argumento, por posição (em
  // corpo de arrow, o objeto volta entre parênteses, como na base).
  const trocas = [
    { ini: imports[0].getFullStart(), fim: imports[0].getEnd(), por: '' },
    ...chamadas.map((ch) => {
      const arg = ch.arguments[0].getText(sf);
      const emArrow = ts.isArrowFunction(ch.parent) && ch.parent.body === ch;
      return {
        ini: ch.getStart(sf),
        fim: ch.getEnd(),
        por: emArrow && argumentoDeObjeto ? `(${arg})` : arg,
      };
    }),
  ].sort((x, y) => y.ini - x.ini);
  let t = texto;
  for (const { ini, fim, por } of trocas) t = t.slice(0, ini) + por + t.slice(fim);
  return { texto: t };
}

function compararForma(arquivo, modulo, lugarValido, esperadas = 1, argumentoDeObjeto = false) {
  const base = naBase(arquivo);
  const head = naArvore(arquivo);
  if (base === null || head === null) return [`${arquivo}: ausente na base ou na árvore`];
  if (base === head) return [`${arquivo}: sem a chamada do helper (arquivo idêntico à base)`];
  const r = normalizarForma(arquivo, head, modulo, lugarValido, esperadas, argumentoDeObjeto);
  if (r.motivos) return r.motivos.map((m) => `${arquivo}: ${m}`);
  const a = imprimir(parse(arquivo, base));
  const b = imprimir(parse(arquivo, r.texto));
  return a === b ? [] : [`${arquivo}: a árvore difere da base além da forma admitida`];
}

const noUseValueDoPrisma = (ch) => {
  const prop = ch.parent;
  if (!prop || !ts.isPropertyAssignment(prop) || prop.name.getText() !== 'useValue') return false;
  const obj = prop.parent;
  return (
    ts.isObjectLiteralExpression(obj) &&
    obj.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText() === 'provide' &&
        ts.isIdentifier(p.initializer) &&
        p.initializer.text === 'PrismaService',
    )
  );
};
const noReturnDoBuildPrismaMock = (ch) => {
  const ret = ch.parent;
  if (!ret || !ts.isReturnStatement(ret)) return false;
  const bloco = ret.parent;
  const fn = bloco?.parent;
  return (
    ts.isBlock(bloco) &&
    fn &&
    ts.isFunctionDeclaration(fn) &&
    fn.name?.text === 'buildPrismaMock'
  );
};

/** R7 (proposta): corpo de arrow atribuída a um dos quatro montadores; devolve o nome. */
const noCorpoDeMontador = (ch) => {
  const arrow = ch.parent;
  if (!arrow || !ts.isArrowFunction(arrow) || arrow.body !== ch) return false;
  const decl = arrow.parent;
  return decl &&
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name) &&
    MONTADORES_DO_GUARD.includes(decl.name.text)
    ? decl.name.text
    : false;
};

// ------------------------------------------------------ declarações (R3)
function declaracoesForaDeCaso(sf, noDeCaso) {
  const porNome = new Map();
  const add = (nome, texto) => {
    if (!porNome.has(nome)) porNome.set(nome, []);
    porNome.get(nome).push(texto);
  };
  const dentroDeCaso = (n) => {
    for (let p = n.parent; p; p = p.parent) if (noDeCaso.has(p)) return true;
    return false;
  };
  const visitar = (n) => {
    if (noDeCaso.has(n)) return;
    if (ts.isVariableStatement(n) && !dentroDeCaso(n)) {
      for (const d of n.declarationList.declarations) {
        const nomes = [];
        const coletar = (b) => {
          if (ts.isIdentifier(b)) nomes.push(b.text);
          else ts.forEachChild(b, coletar);
        };
        coletar(d.name);
        for (const nome of nomes) add(nome, n.getText(sf));
      }
    } else if (
      (ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isEnumDeclaration(n)) &&
      n.name
    ) {
      add(n.name.text, n.getText(sf));
    } else if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      if (c?.name) add(c.name.text, n.getText(sf));
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) add(c.namedBindings.name.text, n.getText(sf));
        else for (const e of c.namedBindings.elements) add(e.name.text, n.getText(sf));
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return porNome;
}
function identificadores(no) {
  const s = new Set();
  const visitar = (n) => {
    if (ts.isIdentifier(n)) s.add(n.text);
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return s;
}

// --------------------------------------------------- alcance dos imports (R6)
const cfg = ts.getParsedCommandLineOfConfigFile(
  path.join(RAIZ, 'tsconfig.json'),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
);
const opcoes = cfg?.options ?? {};

function especificadores(sf) {
  const lista = [];
  const visitar = (n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      lista.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      ((ts.isIdentifier(n.expression) && n.expression.text === 'require') ||
        n.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      lista.push(n.arguments[0].text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ['mock', 'requireActual'].includes(n.expression.name.text) &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      lista.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return lista;
}

function alcancados(entradas, ler) {
  const vistos = new Set();
  const fila = [...entradas];
  while (fila.length) {
    const rel = fila.shift();
    if (vistos.has(rel)) continue;
    vistos.add(rel);
    const texto = ler(rel);
    if (texto === null) continue;
    for (const esp of especificadores(parse(rel, texto))) {
      const r = ts.resolveModuleName(esp, path.join(RAIZ, rel), opcoes, ts.sys)
        .resolvedModule;
      if (!r || r.isExternalLibraryImport) continue;
      const alvo = path.relative(RAIZ, r.resolvedFileName).split(path.sep).join('/');
      if (alvo.startsWith('..') || alvo.includes('node_modules')) continue;
      if (!vistos.has(alvo)) fila.push(alvo);
    }
  }
  return vistos;
}

// ================================================================= execução
const falhas = [];
const falhar = (regra, msg) => falhas.push(`${regra} ${msg}`);

const compartilhados = git('grep', '-l', 'usuario\\.findUnique', BASE, '--', 'test/*.e2e-spec.ts')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.replace(`${BASE}:`, ''));
if (compartilhados.length !== 23) falhar('CENSO', `esperados 23 e2e do dublê compartilhado na base, achados ${compartilhados.length}`);
if (!compartilhados.includes(AUTH_E2E)) falhar('CENSO', `${AUTH_E2E} fora do censo`);
for (const p of PROPRIOS) if (naBase(p) === null) falhar('CENSO', `${p} não existe na base`);
const E2E = [...compartilhados, ...PROPRIOS];

// R1
let totalDeCasos = 0;
for (const arq of [GUARD_SPEC, ...E2E]) {
  const base = naBase(arq);
  const head = naArvore(arq);
  if (base === null || head === null) {
    falhar('R1', `${arq}: ausente na base ou na árvore`);
    continue;
  }
  const cb = casos(parse(arq, base));
  const ch = casos(parse(arq, head));
  totalDeCasos += cb.length;
  const { falta, sobra } = diferencaDeCasos(cb, ch);
  for (const id of falta) falhar('R1', `${arq}: caso sumiu ou mudou de identidade: ${id}`);
  for (const id of sobra) falhar('R1', `${arq}: caso novo ou renomeado: ${id}`);
}
const casosDoGuard = casos(parse(GUARD_SPEC, naBase(GUARD_SPEC) ?? '')).length;

// R2
for (const arq of compartilhados.filter((a) => a !== AUTH_E2E)) {
  const l = linhasAlteradas(arq);
  if (l.length) falhar('R2', `${arq}: ${l.length} linha(s) alterada(s), ex.: ${l[0]}`);
}

// R3
{
  const sfB = parse(AUTH_E2E, naBase(AUTH_E2E) ?? '');
  const sfH = parse(AUTH_E2E, naArvore(AUTH_E2E) ?? '');
  const cb = casos(sfB);
  const ch = casos(sfH);
  const protegidos = cb.filter(
    (c) => c.texto.includes('.expect(403)') || CODIGOS.some((k) => c.texto.includes(k)),
  );
  const textosH = new Map();
  for (const c of ch) {
    if (!textosH.has(c.id)) textosH.set(c.id, []);
    textosH.get(c.id).push(c.texto);
  }
  for (const c of protegidos) {
    if (!(textosH.get(c.id) ?? []).includes(c.texto))
      falhar('R3', `caso protegido alterado ou ausente: ${c.id}`);
  }
  const declB = declaracoesForaDeCaso(sfB, new Set(cb.map((c) => c.no)));
  const declH = declaracoesForaDeCaso(sfH, new Set(ch.map((c) => c.no)));
  const nomes = new Set();
  for (const c of protegidos) for (const n of identificadores(c.no)) nomes.add(n);
  let declaracoesProtegidas = 0;
  for (const nome of nomes) {
    const a = declB.get(nome);
    if (!a) continue;
    declaracoesProtegidas += a.length;
    const b = declH.get(nome) ?? [];
    if (JSON.stringify(a) !== JSON.stringify(b))
      falhar('R3', `declaração referenciada por caso protegido mudou: ${nome}`);
  }
  console.log(
    `R3: ${protegidos.length} casos protegidos em ${AUTH_E2E}; ${declaracoesProtegidas} declarações fora de caso referenciadas por eles`,
  );
  for (const c of protegidos) console.log(`    protegido: ${c.id.slice(0, 160)}`);
  console.log(`    declarações: ${[...nomes].filter((n) => declB.has(n)).join(', ')}`);
}

// R4
for (const arq of PROPRIOS) {
  for (const m of compararForma(arq, './utils/portao-no-duble', noUseValueDoPrisma)) falhar('R4', m);
}

// R5
for (const m of compararForma(PRISMA_MOCK, './portao-no-duble', noReturnDoBuildPrismaMock)) falhar('R5', m);

// R6
const lerUniao = (rel) => naArvore(rel) ?? naBase(rel);
const utils = [...alcancados([GUARD_SPEC, ...E2E], lerUniao)]
  .filter((a) => a.startsWith('test/utils/'))
  .sort();
for (const arq of utils) {
  if (arq === HELPER || arq === PRISMA_MOCK) continue;
  if (naBase(arq) === null) {
    falhar('R6', `${arq}: auxiliar novo alcançado pelos testes, fora das exceções`);
    continue;
  }
  const l = linhasAlteradas(arq);
  if (l.length) falhar('R6', `${arq}: ${l.length} linha(s) alterada(s), ex.: ${l[0]}`);
}
console.log(`R6: auxiliares de test/utils alcançados: ${utils.join(', ')}`);

// R7
if (R7_FORMA) {
  console.log('R7: regra PROPOSTA (--r7=forma), não a da norma aprovada');
  for (const m of compararForma(
    GUARD_SPEC,
    '../../../test/utils/portao-no-duble',
    noCorpoDeMontador,
    MONTADORES_DO_GUARD.length,
    true,
  ))
    falhar('R7', m);
} else {
  const fora = linhasAlteradas(GUARD_SPEC).filter((l) => {
    const corpo = l.slice(1).trim();
    if (corpo === '') return false;
    if (l.startsWith('-') && corpo === LINHA_71) return false;
    return !ALLOWLIST_GUARD.some((k) => corpo.includes(k));
  });
  for (const l of fora) falhar('R7', `${GUARD_SPEC}: linha fora da allowlist: ${l}`);
}

console.log(
  `base=${BASE}; arquivos e2e: ${E2E.length} (${compartilhados.length} compartilhados + ${PROPRIOS.length} próprios); casos na base: ${totalDeCasos} (${casosDoGuard} no teste do guard)`,
);
if (falhas.length) {
  console.log(`REPROVADO — ${falhas.length} violação(ões):`);
  for (const f of falhas) console.log(`  ${f}`);
  process.exit(1);
}
console.log('APROVADO — nenhuma alteração fora da lista permitida.');

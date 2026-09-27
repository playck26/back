/**
 * SPEC-076/AC-030 — as duas ferramentas que provam "um relógio só no portão"
 * como CLASSE, e não como lista (4ª rodada da validação da implementação).
 *
 * A 4ª rodada pôs o relógio do Node dentro de `dentroDaJanelaAutomatica`, só
 * nos dois segundos finais da janela, e a AC-030 continuou verde: a prova de
 * comportamento só olhava decisões longe da fronteira, e a de texto só olhava o
 * corpo do portão e os PARÂMETROS dos helpers. Daí as duas peças:
 *
 * 1. `vigiarRelogios` — durante a chamada, registra TODA leitura de outro
 *    relógio cujo chamador imediato é código de `src/` e cuja pilha passa pelo
 *    portão: `Date` (construtor sem argumento, chamada como função, `now`, e
 *    por isso também `Reflect.construct(Date, [])`), `performance.now`,
 *    `process.hrtime`, `Intl.DateTimeFormat#format`/`formatToParts` sem
 *    instante, e SQL com relógio. Pega a leitura que muda a decisão E a que não
 *    muda, por alias, helper ou nome dinâmico — desde que o caminho execute.
 *    Os casos de fronteira do db-spec existem para que execute.
 * 2. `fechoDoPortao` — o fecho ESTÁTICO: toda função que o portão alcança, em
 *    qualquer módulo local, transitivamente (import com alias, `* as`,
 *    `this.metodo`, função do mesmo módulo). É o que cobre o ramo que nenhum
 *    caso executa.
 *
 * **Limite, declarado:** uma leitura por nome montado em tempo de execução
 * (`globalThis['Da' + 'te']`) num ramo que NENHUM caso executa escapa das
 * duas. O vigia não a vê porque não roda; o fecho não a vê porque não é texto.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PORTAO = 'travarEValidarOcorrencia';
const ESTE_ARQUIVO = /relogios-do-portao/;

/** Relógio no SQL, por qualquer nome que o Postgres aceite. */
export const RELOGIO_SQL =
  /\b(clock_timestamp|statement_timestamp|transaction_timestamp|now|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocal(timestamp|time)\b/i;

// ---------------------------------------------------------------------------
// 1. O vigia
// ---------------------------------------------------------------------------

/**
 * O chamador, se a leitura é de código nosso DENTRO do portão; senão `null`.
 * O Prisma e o próprio vigia leem relógio o tempo todo: não contam.
 */
function chamadorNoPortao(): string | null {
  const limite = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const pilha = new Error().stack ?? '';
  Error.stackTraceLimit = limite;
  if (!pilha.includes(PORTAO)) return null;
  const chamador = pilha
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find(
      (l) =>
        !ESTE_ARQUIVO.test(l) &&
        !/\((native|<anonymous>)\)|node:internal|^at <anonymous>/.test(l),
    );
  if (!chamador || /node_modules/.test(chamador)) return null;
  return /[\\/]src[\\/]/.test(chamador) ? chamador : null;
}

type Leituras = string[];

/** `Reflect.apply` tipado: o proxy repassa a chamada com o `this` original. */
function chamar(f: unknown, este: unknown, args: unknown[]): unknown {
  return Reflect.apply(f as (...a: unknown[]) => unknown, este, args);
}

function textoDoSql(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg)) return arg.join(' ? ');
  if (arg && typeof arg === 'object') {
    const o = arg as { sql?: string; strings?: string[] };
    return o.sql ?? (o.strings ? o.strings.join(' ? ') : '');
  }
  return '';
}

const RAW = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

function comRawVigiado<T extends object>(
  cliente: T,
  anotar: (f: string) => void,
): T {
  return new Proxy(cliente, {
    get(alvo, p) {
      const v = Reflect.get(alvo, p, alvo) as unknown;
      if (typeof p === 'string' && RAW.has(p) && typeof v === 'function') {
        return (...args: unknown[]) => {
          const sql = textoDoSql(args[0]);
          if (RELOGIO_SQL.test(sql)) {
            anotar(`SQL com relógio: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
          }
          return chamar(v, alvo, args);
        };
      }
      return typeof v === 'function'
        ? (...a: unknown[]) => chamar(v, alvo, a)
        : v;
    },
  });
}

/**
 * O cliente Prisma que o serviço recebe no caso vigiado: o `$transaction`
 * interativo entrega um `tx` com os `$queryRaw…`/`$executeRaw…` vigiados.
 */
export function prismaVigiado<T extends object>(
  cliente: T,
  leituras: Leituras,
): T {
  const anotar = (fonte: string) => {
    const c = chamadorNoPortao();
    // O provedor de produção lê `clock_timestamp()` — é o relógio único. Nos
    // casos vigiados o relógio é o controlado e nem chega aqui; a exclusão é
    // para o caso de alguém tirar o `instante` sem querer.
    if (c && !/relogio-da-presenca\.ts/.test(c))
      leituras.push(`${fonte}  <-  ${c}`);
  };
  const vigiado = comRawVigiado(cliente, anotar);
  return new Proxy(vigiado, {
    get(alvo, p) {
      if (p === '$transaction') {
        const original = Reflect.get(cliente, '$transaction', cliente) as (
          ...a: unknown[]
        ) => unknown;
        return (arg: unknown, ...resto: unknown[]) =>
          typeof arg === 'function'
            ? chamar(original, cliente, [
                (tx: object) =>
                  (arg as (t: object) => unknown)(comRawVigiado(tx, anotar)),
                ...resto,
              ])
            : chamar(original, cliente, [arg, ...resto]);
      }
      return Reflect.get(alvo, p, alvo);
    },
  });
}

/**
 * Roda `fn` com os relógios do PROCESSO vigiados (os do SQL são vigiados pelo
 * `prismaVigiado`, no cliente do serviço). Deve ser chamado DENTRO de
 * `comNodeEm`: vigia o `Date` que estiver instalado, falso ou não.
 */
export async function vigiarRelogios<T>(
  leituras: Leituras,
  fn: () => Promise<T>,
): Promise<T> {
  const anotar = (fonte: string) => {
    const c = chamadorNoPortao();
    if (c) leituras.push(`${fonte}  <-  ${c}`);
  };
  const DateInstalado = globalThis.Date;
  const DateVigiado = new Proxy(DateInstalado, {
    construct(alvo, args, novoAlvo) {
      if (args.length === 0) anotar('new Date()');
      return Reflect.construct(
        alvo,
        args,
        novoAlvo === DateVigiado ? alvo : novoAlvo,
      ) as object;
    },
    apply(alvo, este, args) {
      anotar('Date()');
      return Reflect.apply(alvo, este, args) as unknown;
    },
    get(alvo, p) {
      if (p === 'now') {
        return () => {
          anotar('Date.now()');
          return alvo.now();
        };
      }
      return Reflect.get(alvo, p, alvo) as unknown;
    },
  });
  const perf = globalThis.performance;
  // Guardadas para restaurar; chamadas com o `this` certo, por `chamar`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const perfNow = perf.now;
  const hrtime = process.hrtime;
  const fmt = Object.getOwnPropertyDescriptor(
    Intl.DateTimeFormat.prototype,
    'format',
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const partes = Intl.DateTimeFormat.prototype.formatToParts;

  globalThis.Date = DateVigiado as DateConstructor;
  Object.defineProperty(perf, 'now', {
    configurable: true,
    writable: true,
    value: () => {
      anotar('performance.now()');
      return chamar(perfNow, perf, []);
    },
  });
  process.hrtime = Object.assign(
    (tempo?: [number, number]) => {
      anotar('process.hrtime()');
      return chamar(hrtime, process, [tempo]) as [number, number];
    },
    {
      bigint: () => {
        anotar('process.hrtime.bigint()');
        return hrtime.bigint();
      },
    },
  );
  Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', {
    configurable: true,
    get(this: Intl.DateTimeFormat) {
      const f = fmt?.get?.call(this) as (d?: Date | number) => string;
      return (d?: Date | number) => {
        if (d === undefined)
          anotar('Intl.DateTimeFormat#format() sem instante');
        return f(d);
      };
    },
  });
  Intl.DateTimeFormat.prototype.formatToParts = function (
    this: Intl.DateTimeFormat,
    d?: Date | number,
  ) {
    if (d === undefined)
      anotar('Intl.DateTimeFormat#formatToParts() sem instante');
    return chamar(partes, this, [d]) as Intl.DateTimeFormatPart[];
  };
  try {
    return await fn();
  } finally {
    globalThis.Date = DateInstalado;
    delete (perf as { now?: unknown }).now;
    if (perf.now !== perfNow) {
      Object.defineProperty(perf, 'now', {
        configurable: true,
        writable: true,
        value: perfNow,
      });
    }
    process.hrtime = hrtime;
    if (fmt)
      Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', fmt);
    Intl.DateTimeFormat.prototype.formatToParts = partes;
  }
}

// ---------------------------------------------------------------------------
// 2. O fecho estático
// ---------------------------------------------------------------------------

/**
 * O código com comentários trocados por espaço e, na versão `estrutura`, o
 * conteúdo de strings também — mas NÃO as expressões `${…}` dos templates, que
 * são código. Mesmo comprimento, para os índices servirem às duas.
 */
function lexar(fonte: string): { codigo: string; estrutura: string } {
  const codigo = fonte.split('');
  const estrutura = fonte.split('');
  const pilha: ('codigo' | 'template')[] = ['codigo'];
  const chaves: number[] = [];
  let i = 0;
  const branco = (a: number, b: number, tambemCodigo: boolean) => {
    for (let k = a; k < b; k += 1) {
      if (fonte[k] === '\n') continue;
      estrutura[k] = ' ';
      if (tambemCodigo) codigo[k] = ' ';
    }
  };
  while (i < fonte.length) {
    const topo = pilha[pilha.length - 1];
    const c = fonte[i];
    if (topo === 'template') {
      if (c === '\\') {
        branco(i, i + 2, false);
        i += 2;
      } else if (c === '`') {
        pilha.pop();
        i += 1;
      } else if (c === '$' && fonte[i + 1] === '{') {
        pilha.push('codigo');
        chaves.push(0);
        i += 2;
      } else {
        branco(i, i + 1, false);
        i += 1;
      }
      continue;
    }
    if (c === '/' && fonte[i + 1] === '/') {
      const fim = fonte.indexOf('\n', i);
      const f = fim < 0 ? fonte.length : fim;
      branco(i, f, true);
      i = f;
    } else if (c === '/' && fonte[i + 1] === '*') {
      const fim = fonte.indexOf('*/', i + 2);
      const f = fim < 0 ? fonte.length : fim + 2;
      branco(i, f, true);
      i = f;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < fonte.length && fonte[k] !== c) k += fonte[k] === '\\' ? 2 : 1;
      branco(i + 1, k, false);
      i = k + 1;
    } else if (c === '`') {
      pilha.push('template');
      i += 1;
    } else if (c === '{' && pilha.length > 1) {
      chaves[chaves.length - 1] += 1;
      i += 1;
    } else if (
      c === '}' &&
      pilha.length > 1 &&
      chaves[chaves.length - 1] === 0
    ) {
      chaves.pop();
      pilha.pop();
      i += 1;
    } else {
      if (c === '}' && pilha.length > 1) chaves[chaves.length - 1] -= 1;
      i += 1;
    }
  }
  return { codigo: codigo.join(''), estrutura: estrutura.join('') };
}

/** Índice do fechamento que casa com a abertura em `inicio`. */
function fechamento(estrutura: string, inicio: number): number {
  const par: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const abre = estrutura[inicio];
  const fecha = par[abre];
  let nivel = 0;
  for (let k = inicio; k < estrutura.length; k += 1) {
    if (estrutura[k] === abre) nivel += 1;
    else if (estrutura[k] === fecha) {
      nivel -= 1;
      if (nivel === 0) return k;
    }
  }
  return -1;
}

/** Depois do `)` dos parâmetros: pula o tipo de retorno e acha o `{` do corpo. */
function inicioDoCorpo(estrutura: string, depoisDosParametros: number): number {
  let k = depoisDosParametros;
  while (/\s/.test(estrutura[k] ?? '')) k += 1;
  if (estrutura[k] === '{') return k;
  if (estrutura[k] !== ':') return -1;
  k += 1;
  let nivel = 0;
  let anterior = ':';
  for (; k < estrutura.length; k += 1) {
    const c = estrutura[k];
    if (c === '=' && estrutura[k + 1] === '>' && nivel === 0) return -1;
    if ('<(['.includes(c)) nivel += 1;
    else if ('>)]'.includes(c)) nivel -= 1;
    else if (c === '{' && nivel === 0) {
      if (':|&,'.includes(anterior)) {
        k = fechamento(estrutura, k);
        anterior = '}';
        continue;
      }
      return k;
    } else if (c === ';' && nivel === 0) return -1;
    if (!/\s/.test(c)) anterior = c;
  }
  return -1;
}

export interface Funcao {
  arquivo: string;
  nome: string;
  parametros: string;
  corpo: string;
}

interface Modulo {
  arquivo: string;
  funcoes: Map<string, Funcao>;
  /** nome local -> [arquivo, nome original] */
  importados: Map<string, [string, string]>;
  /** namespace local -> arquivo */
  namespaces: Map<string, string>;
}

const NAO_E_METODO = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'catch',
  'function',
  'await',
  'new',
  'typeof',
  'constructor',
  'super',
  'throw',
  'do',
  'else',
]);

const cache = new Map<string, Modulo>();

function resolver(de: string, rel: string): string | null {
  const base = join(dirname(de), rel);
  for (const c of [`${base}.ts`, join(base, 'index.ts')])
    if (existsSync(c)) return c;
  return null;
}

export function lerModulo(arquivo: string): Modulo {
  const pronto = cache.get(arquivo);
  if (pronto) return pronto;
  const fonte = readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
  const { codigo, estrutura } = lexar(fonte);
  const funcoes = new Map<string, Funcao>();
  const registrar = (nome: string, abreParametros: number, seta: boolean) => {
    const fechaParametros = fechamento(estrutura, abreParametros);
    if (fechaParametros < 0) return;
    let corpoInicio = inicioDoCorpo(estrutura, fechaParametros + 1);
    let corpoFim: number;
    if (corpoInicio >= 0) {
      corpoFim = fechamento(estrutura, corpoInicio);
    } else {
      // Só uma arrow tem corpo depois de `=>`; declaração e método sem `{`
      // logo depois dos parâmetros não são função (é uma chamada).
      if (!seta) return;
      const m = /^\s*(?::[^=]*)?=>\s*/.exec(
        estrutura.slice(fechaParametros + 1),
      );
      if (!m) return;
      corpoInicio = fechaParametros + 1 + m[0].length;
      corpoFim =
        estrutura[corpoInicio] === '{'
          ? fechamento(estrutura, corpoInicio)
          : estrutura.indexOf(';\n', corpoInicio);
    }
    if (corpoFim < 0 || funcoes.has(nome)) return;
    funcoes.set(nome, {
      arquivo,
      nome,
      parametros: codigo.slice(abreParametros + 1, fechaParametros),
      corpo: codigo.slice(corpoInicio, corpoFim + 1),
    });
  };
  for (const m of estrutura.matchAll(
    /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>()]*>)?\s*\(/g,
  )) {
    registrar(m[1], (m.index ?? 0) + m[0].length - 1, false);
  }
  for (const m of estrutura.matchAll(
    /(?:^|\n)(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\s*)?\(/g,
  )) {
    registrar(m[1], (m.index ?? 0) + m[0].length - 1, true);
  }
  // Métodos de classe: dois espaços de recuo, e o corpo logo depois.
  for (const m of estrutura.matchAll(
    /\n {2}(?:(?:private|public|protected|static|async|override|readonly)\s+)*(\w+)\s*(?:<[^>()]*>)?\s*\(/g,
  )) {
    if (NAO_E_METODO.has(m[1])) continue;
    registrar(m[1], (m.index ?? 0) + m[0].length - 1, false);
  }
  const importados = new Map<string, [string, string]>();
  const namespaces = new Map<string, string>();
  for (const m of codigo.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'(\.[^']+)'/g,
  )) {
    const alvo = resolver(arquivo, m[2]);
    if (!alvo) continue;
    for (const item of m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [original, local] = item.replace(/^type\s+/, '').split(/\s+as\s+/);
      importados.set((local ?? original).trim(), [alvo, original.trim()]);
    }
  }
  for (const m of codigo.matchAll(
    /import\s+\*\s+as\s+(\w+)\s+from\s*'(\.[^']+)'/g,
  )) {
    const alvo = resolver(arquivo, m[2]);
    if (alvo) namespaces.set(m[1], alvo);
  }
  const modulo = { arquivo, funcoes, importados, namespaces };
  cache.set(arquivo, modulo);
  return modulo;
}

/** Os argumentos (no nível de cima) de cada chamada a `nome(` no corpo. */
export function argumentosDasChamadas(corpo: string, nome: string): string[][] {
  const { estrutura } = lexar(corpo);
  const saida: string[][] = [];
  const re = new RegExp(`(?<![\\w.])${nome.replace(/\./g, '\\.')}\\s*\\(`, 'g');
  for (const m of estrutura.matchAll(re)) {
    const abre = (m.index ?? 0) + m[0].length - 1;
    const fecha = fechamento(estrutura, abre);
    if (fecha < 0) continue;
    const args: string[] = [];
    let nivel = 0;
    let de = abre + 1;
    for (let k = abre + 1; k < fecha; k += 1) {
      const c = estrutura[k];
      if ('([{'.includes(c)) nivel += 1;
      else if (')]}'.includes(c)) nivel -= 1;
      else if (c === ',' && nivel === 0) {
        args.push(corpo.slice(de, k).trim());
        de = k + 1;
      }
    }
    const ultimo = corpo.slice(de, fecha).trim();
    if (ultimo) args.push(ultimo);
    saida.push(args);
  }
  return saida;
}

/** O índice do primeiro parâmetro cujo padrão é um relógio, ou -1. */
export function parametroComRelogioPadrao(parametros: string): number {
  const { estrutura } = lexar(parametros);
  const partes: string[] = [];
  let nivel = 0;
  let de = 0;
  for (let k = 0; k < estrutura.length; k += 1) {
    const c = estrutura[k];
    if ('([{<'.includes(c)) nivel += 1;
    else if (')]}>'.includes(c)) nivel -= 1;
    else if (c === ',' && nivel === 0) {
      partes.push(parametros.slice(de, k));
      de = k + 1;
    }
  }
  partes.push(parametros.slice(de));
  return partes.findIndex((p) =>
    /=\s*(new\s+Date\b|Date\s*\.\s*now\b|Date\s*\(|performance\s*\.\s*now\b)/.test(
      p,
    ),
  );
}

/**
 * Relógio no CORPO de uma função que não é o portão. Aqui `new Date(x)` é
 * legítimo (é conversão, não leitura); o que lê o relógio não é.
 */
export const FONTES_DE_TEMPO_NO_HELPER: [string, RegExp][] = [
  ['new Date() sem argumento', /\bnew\s+Date\s*\(\s*\)/],
  ['new Date sem parênteses', /\bnew\s+Date\b(?!\s*\()/],
  ['Date() como função', /(?<![\w.]|new\s)\bDate\s*\(/],
  ['Date.now', /\bDate\s*\.\s*now\b/],
  [
    'Date como valor (alias)',
    /[=(,]\s*Date\s*[;,)\n]|Reflect\s*\.\s*construct\s*\(\s*Date\b/,
  ],
  ['performance.now / timeOrigin', /\bperformance\s*\.\s*(now|timeOrigin)\b/],
  ['process.hrtime / uptime', /\bprocess\s*\.\s*(hrtime|uptime)\b/],
  ['Intl …format() sem instante', /\.\s*format(ToParts)?\s*\(\s*\)/],
  // Qualquer `…now()`, de qualquer objeto: num helper de tempo do portão não
  // há `now` legítimo, e a regra pega `D.now()` com `D` vindo de onde vier.
  ['qualquer now()', /\bnow\s*\(/],
  ['relógio do SQL', RELOGIO_SQL],
];

export interface Violacao {
  onde: string;
  regra: string;
  trecho: string;
}

/**
 * O fecho: a partir do método `inicio` de `arquivo`, toda função alcançada.
 * Devolve as funções visitadas e as violações: relógio no corpo (fora do
 * portão, cuja regra é mais estrita e fica no db-spec), e chamada a função com
 * relógio padrão que não passa o argumento.
 */
export function fechoDoPortao(
  arquivo: string,
  inicio: string,
): { visitadas: string[]; violacoes: Violacao[]; chamadasComPadrao: number } {
  const visitadas: string[] = [];
  const violacoes: Violacao[] = [];
  let chamadasComPadrao = 0;
  const fila: [string, string][] = [[arquivo, inicio]];
  const vistas = new Set<string>();
  while (fila.length) {
    const [arq, nome] = fila.shift() as [string, string];
    const chave = `${arq}#${nome}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const modulo = lerModulo(arq);
    const funcao = modulo.funcoes.get(nome);
    if (!funcao) continue;
    visitadas.push(`${arq.split(/[\\/]src[\\/]/)[1]}#${nome}`);
    if (nome !== inicio) {
      for (const [regra, re] of FONTES_DE_TEMPO_NO_HELPER) {
        const achado = re.exec(funcao.corpo);
        if (achado) violacoes.push({ onde: chave, regra, trecho: achado[0] });
      }
    }
    // Quem este corpo chama, resolvido.
    const alvos: [string, string, string][] = []; // [nome no corpo, arquivo, nome real]
    for (const m of funcao.corpo.matchAll(
      /(?<![\w.])(this\.)?(\w+)(?:\.(\w+))?\s*\(/g,
    )) {
      const [, este, a, b] = m;
      if (este && !b && modulo.funcoes.has(a))
        alvos.push([`this.${a}`, arq, a]);
      else if (!este && b && modulo.namespaces.has(a)) {
        alvos.push([`${a}.${b}`, modulo.namespaces.get(a) as string, b]);
      } else if (!este && !b && modulo.importados.has(a)) {
        const [alvo, original] = modulo.importados.get(a) as [string, string];
        alvos.push([a, alvo, original]);
      } else if (!este && !b && modulo.funcoes.has(a)) alvos.push([a, arq, a]);
    }
    const unicos = new Map(alvos.map((x) => [x.join('|'), x]));
    for (const [noCorpo, alvoArq, alvoNome] of unicos.values()) {
      fila.push([alvoArq, alvoNome]);
      const alvo = lerModulo(alvoArq).funcoes.get(alvoNome);
      if (!alvo) continue;
      const k = parametroComRelogioPadrao(alvo.parametros);
      if (k < 0) continue;
      for (const args of argumentosDasChamadas(funcao.corpo, noCorpo)) {
        chamadasComPadrao += 1;
        if (args.length <= k || args[k] === 'undefined') {
          violacoes.push({
            onde: chave,
            regra: `${alvoNome} cai no relógio padrão (o argumento ${k + 1} falta)`,
            trecho: `${noCorpo}(${args.join(', ')})`,
          });
        }
      }
    }
  }
  return { visitadas, violacoes, chamadasComPadrao };
}

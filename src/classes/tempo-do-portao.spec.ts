/**
 * SPEC-076/D11, AC-030 — **a decisão de tempo do portão só conhece o `agora`
 * que recebe.** Provado por construção, e não por busca:
 *
 * 1. `tempo-do-portao.ts` e o que ele importa rodam num **realm sem relógio**
 *    (`vm`): `Date.now`, `Date()`, `new Date()` sem argumento e
 *    `Intl.DateTimeFormat#format…` sem instante lançam E ficam registrados;
 *    não há `process`, `performance`, `setTimeout`, `queueMicrotask` nem
 *    `require` de pacote. Pelo ECMAScript, `Date` e `Intl.DateTimeFormat` são
 *    as únicas fontes de tempo do JavaScript sem o host — e o host não está
 *    lá. Nome montado (`globalThis['Da' + 'te']`), alias, callback, cache de
 *    módulo: tudo chega ao mesmo `Date` neutralizado.
 * 2. **Cobertura total de blocos** (a do próprio V8, pelo inspector): todo
 *    bloco da função, e de toda função do `date-time.util` que ela chama, roda
 *    em algum caso. Não sobra ramo que o realm não tenha visto.
 * 3. Os casos colam em cada fronteira (1 ms de cada lado) das três janelas.
 *
 * O que liga isto ao portão de produção é a prova do db-spec: o corpo de
 * `travarEValidarOcorrencia` só pode fazer as chamadas de uma lista fechada, e
 * a decisão de tempo é esta função.
 */
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Script, createContext } from 'node:vm';
import * as ts from 'typescript';

const RAIZ = join(__dirname, '..', '..');
const ENTRADA = join(__dirname, 'tempo-do-portao.ts');
const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * O que roda DENTRO do realm, antes de qualquer módulo: neutraliza os dois
 * relógios da linguagem e monta um `require` que só conhece os módulos
 * registrados. Nenhuma função de fora entra no realm (uma função de fora
 * daria o `Function` de fora, e por ele o `process` de fora).
 */
const BOOTSTRAP = String.raw`(() => {
  const violacoes = [];
  const relogio = (onde) => {
    violacoes.push(onde);
    throw new Error('RELOGIO LIDO NO REALM: ' + onde);
  };
  const D = Date;
  const SemRelogio = new Proxy(D, {
    construct(alvo, args, novoAlvo) {
      if (args.length === 0) relogio('new Date()');
      return Reflect.construct(alvo, args, novoAlvo === SemRelogio ? alvo : novoAlvo);
    },
    apply() { return relogio('Date()'); },
    get(alvo, p) {
      if (p === 'now') return () => relogio('Date.now()');
      return Reflect.get(alvo, p);
    },
  });
  Object.defineProperty(D.prototype, 'constructor', { value: SemRelogio });
  Object.defineProperty(globalThis, 'Date', { value: SemRelogio, writable: false, configurable: false });
  const P = Intl.DateTimeFormat.prototype;
  const format = Object.getOwnPropertyDescriptor(P, 'format').get;
  Object.defineProperty(P, 'format', {
    get() {
      const f = format.call(this);
      return (d) => (d === undefined ? relogio('Intl format()') : f(d));
    },
  });
  for (const m of ['formatToParts', 'formatRange', 'formatRangeToParts']) {
    const original = P[m];
    Object.defineProperty(P, m, {
      value(...a) {
        if (a[0] === undefined) return relogio('Intl ' + m + '()');
        return original.apply(this, a);
      },
    });
  }
  Object.freeze(P);
  const registro = {};
  const exigir = (id) => {
    const m = registro[id];
    if (!m) throw new Error('modulo fora do realm: ' + id);
    if (!m.carregado) {
      m.carregado = true;
      const requireDoModulo = (especificador) => {
        const alvo = m.mapa[especificador];
        if (!alvo) throw new Error('dependencia fora do realm: ' + especificador + ' em ' + id);
        return exigir(alvo);
      };
      m.embrulho(m.modulo.exports, requireDoModulo, m.modulo);
    }
    return m.modulo.exports;
  };
  return {
    violacoes: () => JSON.stringify(violacoes),
    registrar(id, embrulho, mapaJson) {
      registro[id] = { embrulho, mapa: JSON.parse(mapaJson), modulo: { exports: {} }, carregado: false };
    },
    decidir(id, entradaJson) {
      const e = JSON.parse(entradaJson);
      try {
        const r = exigir(id).decidirTempoDoPortao({
          agora: e.agora === null ? undefined : new Date(e.agora),
          data: new Date(e.data),
          horaInicio: new Date(e.horaInicio),
          origemInicial: e.origemInicial,
          fechadaAutomaticamenteEm: e.fechada === null ? null : new Date(e.fechada),
        });
        return JSON.stringify(r);
      } catch (erro) {
        return JSON.stringify({ erro: String(erro && erro.message) });
      }
    },
  };
})()`;

interface Realm {
  violacoes(): string;
  registrar(id: string, embrulho: unknown, mapaJson: string): void;
  decidir(id: string, entradaJson: string): string;
}

/** Transpila a entrada e as dependências LOCAIS; pacote é recusado já aqui. */
function modulosDoRealm(
  entrada: string,
): Map<string, { js: string; mapa: Record<string, string> }> {
  const saida = new Map<string, { js: string; mapa: Record<string, string> }>();
  const visitar = (arquivo: string) => {
    const id = relative(RAIZ, arquivo).replace(/\\/g, '/');
    if (saida.has(id)) return;
    const js = ts.transpileModule(readFileSync(arquivo, 'utf8'), {
      fileName: arquivo,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const mapa: Record<string, string> = {};
    saida.set(id, { js, mapa });
    for (const [, esp] of js.matchAll(/require\("([^"]+)"\)/g)) {
      if (!esp.startsWith('.')) {
        throw new Error(`dependência fora do realm: ${esp} em ${id}`);
      }
      const alvo = `${resolve(dirname(arquivo), esp)}.ts`;
      mapa[esp] = relative(RAIZ, alvo).replace(/\\/g, '/');
      visitar(alvo);
    }
  };
  visitar(entrada);
  return saida;
}

interface Caso {
  nome: string;
  agora: number | null;
  data: string;
  hora: string;
  origemInicial: string | null;
  fechada: number | null;
  esperado: {
    dentroDaJanelaAutomatica?: boolean | null;
    recusa?: string | null;
    erro?: RegExp;
  };
}

/** O clube é UTC−3 o ano inteiro (sem horário de verão desde 2019). */
const noClube = (dia: string, hora: string) =>
  Date.parse(`${dia}T${hora}:00.000-03:00`);
const HORA = '10:00';
const D = '2026-09-10';
const INICIO = noClube(D, HORA);
const FIM_RETROATIVA = noClube('2026-09-18', '00:00'); // meia-noite de data + 8
const FECHADA = Date.parse('2026-09-11T02:00:00.000Z');
const FIM_AUTOMATICA = FECHADA + 7 * MS_DIA;

const CASOS: Caso[] = [
  // início da aula (e a rede de segurança por dia, na mesma condição)
  {
    nome: 'início: 1 ms antes',
    agora: INICIO - 1,
    data: D,
    hora: HORA,
    origemInicial: null,
    fechada: null,
    esperado: { recusa: 'AULA_FUTURA', dentroDaJanelaAutomatica: null },
  },
  {
    nome: 'início: no instante',
    agora: INICIO,
    data: D,
    hora: HORA,
    origemInicial: null,
    fechada: null,
    esperado: { recusa: null },
  },
  {
    nome: 'aula de amanhã',
    agora: noClube('2026-09-09', '23:00'),
    data: D,
    hora: HORA,
    origemInicial: null,
    fechada: null,
    esperado: { recusa: 'AULA_FUTURA' },
  },
  // janela retroativa
  {
    nome: 'retroativa: 1 ms antes da meia-noite de data+8',
    agora: FIM_RETROATIVA - 1,
    data: D,
    hora: HORA,
    origemInicial: 'professor',
    fechada: null,
    esperado: { recusa: null },
  },
  {
    nome: 'retroativa: na meia-noite de data+8',
    agora: FIM_RETROATIVA,
    data: D,
    hora: HORA,
    origemInicial: 'professor',
    fechada: null,
    esperado: { recusa: 'AULA_ANTIGA_RETROATIVA' },
  },
  // janela da automática
  {
    nome: 'automática: 1 ms antes do fim',
    agora: FIM_AUTOMATICA - 1,
    data: D,
    hora: HORA,
    origemInicial: 'automatica',
    fechada: FECHADA,
    esperado: { recusa: null, dentroDaJanelaAutomatica: true },
  },
  {
    nome: 'automática: no fim',
    agora: FIM_AUTOMATICA,
    data: D,
    hora: HORA,
    origemInicial: 'automatica',
    fechada: FECHADA,
    esperado: {
      recusa: 'AULA_ANTIGA_AUTOMATICA',
      dentroDaJanelaAutomatica: false,
    },
  },
  {
    nome: 'automática: a janela da automática não olha a data da aula',
    agora: FIM_RETROATIVA + 1,
    data: D,
    hora: HORA,
    origemInicial: 'automatica',
    fechada: FIM_RETROATIVA - MS_DIA,
    esperado: { recusa: null, dentroDaJanelaAutomatica: true },
  },
  {
    nome: 'automática sem fechamento gravado',
    agora: INICIO + 1,
    data: D,
    hora: HORA,
    origemInicial: 'automatica',
    fechada: null,
    esperado: {
      recusa: 'AULA_ANTIGA_AUTOMATICA',
      dentroDaJanelaAutomatica: null,
    },
  },
  {
    nome: 'humana depois de automática: a janela é a retroativa, o campo vem calculado',
    agora: FIM_RETROATIVA - 1,
    data: D,
    hora: HORA,
    origemInicial: 'professor',
    fechada: FECHADA,
    esperado: { recusa: null, dentroDaJanelaAutomatica: false },
  },
  // o instante é obrigatório
  {
    nome: 'sem `agora`: erro, e não o relógio padrão dos helpers',
    agora: null,
    data: D,
    hora: HORA,
    origemInicial: null,
    fechada: null,
    esperado: { erro: /agora. é obrigatório/ },
  },
  {
    nome: '`agora` inválido: erro',
    agora: Number.NaN,
    data: D,
    hora: HORA,
    origemInicial: null,
    fechada: null,
    esperado: { erro: /agora. é obrigatório/ },
  },
];

describe('AC-030 — a decisão de tempo do portão, num realm sem relógio', () => {
  let sessao: Session;
  let realm: Realm;
  let resultados: Map<string, Record<string, unknown>>;
  let cobertura: {
    url: string;
    functions: {
      functionName: string;
      ranges: { startOffset: number; endOffset: number; count: number }[];
    }[];
  }[];
  const codigoPorUrl = new Map<string, string>();
  const idEntrada = relative(RAIZ, ENTRADA).replace(/\\/g, '/');

  beforeAll(async () => {
    sessao = new Session();
    sessao.connect();
    await sessao.post('Profiler.enable');
    // Antes de compilar qualquer script do realm: é o que liga a contagem por bloco.
    await sessao.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });

    const ctx = createContext({});
    realm = new Script(BOOTSTRAP, {
      filename: 'realm:///bootstrap.js',
    }).runInContext(ctx) as Realm;
    for (const [id, { js, mapa }] of modulosDoRealm(ENTRADA)) {
      const codigo = `(function (exports, require, module) {${js}\n})`;
      const url = `realm:///${id}`;
      codigoPorUrl.set(url, codigo);
      realm.registrar(
        id,
        new Script(codigo, { filename: url }).runInContext(ctx),
        JSON.stringify(mapa),
      );
    }

    resultados = new Map();
    for (const c of CASOS) {
      const entrada = {
        agora: c.agora === null ? null : c.agora,
        data: Date.parse(`${c.data}T00:00:00.000Z`),
        horaInicio: Date.parse(`1970-01-01T${c.hora}:00.000Z`),
        origemInicial: c.origemInicial,
        fechada: c.fechada,
      };
      // NaN não sobrevive ao JSON: vira `null`; o realm recebe `new Date(NaN)` por outro caminho.
      const json = Number.isNaN(c.agora)
        ? JSON.stringify(entrada).replace('"agora":null', '"agora":"x"')
        : JSON.stringify(entrada);
      resultados.set(
        c.nome,
        JSON.parse(realm.decidir(idEntrada, json)) as Record<string, unknown>,
      );
    }
    // Um callback agendado no realm teria de rodar antes da conta.
    await new Promise((r) => setImmediate(r));

    const { result } = (await sessao.post('Profiler.takePreciseCoverage')) as {
      result: typeof cobertura;
    };
    cobertura = result.filter((s) => s.url.startsWith('realm:///src/'));
    await sessao.post('Profiler.stopPreciseCoverage');
    await sessao.post('Profiler.disable');
    sessao.disconnect();
  });

  it.each(CASOS.map((c) => [c.nome, c] as const))('%s', (_nome, c) => {
    const r = resultados.get(c.nome) as Record<string, unknown>;
    if (c.esperado.erro) {
      expect(String(r.erro)).toMatch(c.esperado.erro);
      return;
    }
    expect(r.erro).toBeUndefined();
    if ('recusa' in c.esperado) expect(r.recusa).toBe(c.esperado.recusa);
    if ('dentroDaJanelaAutomatica' in c.esperado) {
      expect(r.dentroDaJanelaAutomatica).toBe(
        c.esperado.dentroDaJanelaAutomatica,
      );
    }
  });

  it('nenhum relógio foi lido no realm, em caso nenhum (nem em `catch`, nem em callback)', () => {
    expect(JSON.parse(realm.violacoes())).toEqual([]);
  });

  it('o realm só carregou o módulo da decisão e o `date-time.util`', () => {
    expect([...codigoPorUrl.keys()].sort()).toEqual([
      'realm:///src/classes/tempo-do-portao.ts',
      'realm:///src/courts/date-time.util.ts',
    ]);
  });

  it('cobertura total: todo bloco da decisão, e de toda função que ela chama, rodou', () => {
    const descobertos: string[] = [];
    let funcoesConferidas = 0;
    for (const script of cobertura) {
      const codigo = codigoPorUrl.get(script.url) as string;
      const ehEntrada = script.url.endsWith('/tempo-do-portao.ts');
      for (const f of script.functions) {
        const [corpo, ...blocos] = f.ranges;
        if (corpo.count === 0) {
          // Função do `date-time.util` que a decisão não chama: fora do alcance.
          // Na própria decisão, função nunca chamada é código não provado.
          if (ehEntrada)
            descobertos.push(
              `${script.url} função nunca chamada: ${f.functionName}`,
            );
          continue;
        }
        funcoesConferidas += 1;
        for (const b of blocos) {
          if (b.count === 0) {
            descobertos.push(
              `${script.url} ${f.functionName}: ${codigo.slice(b.startOffset, b.endOffset).replace(/\s+/g, ' ').slice(0, 80)}`,
            );
          }
        }
      }
    }
    expect(descobertos).toEqual([]);
    // Não é vacuidade: a decisão e os helpers de tempo que ela usa rodaram.
    const chamadas = cobertura.flatMap((s) =>
      s.functions
        .filter((f) => f.ranges[0].count > 0)
        .map((f) => f.functionName),
    );
    expect(chamadas).toEqual(
      expect.arrayContaining([
        'decidirTempoDoPortao',
        'hojeNoFusoDoClube',
        'aulaJaComecou',
        'agoraNoFusoDoClube',
        'minutosDaHora',
      ]),
    );
    expect(funcoesConferidas).toBeGreaterThan(5);
  });

  it('o realm não tem relógio nenhum: a própria neutralização é conferida', () => {
    const ctx = createContext({});
    const r = new Script(BOOTSTRAP, {
      filename: 'realm:///bootstrap-sonda.js',
    }).runInContext(ctx) as Realm;
    const sonda = (expr: string) =>
      String(
        new Script(
          `(() => { try { return String(${expr}); } catch (e) { return 'LANCOU'; } })()`,
        ).runInContext(ctx),
      );
    expect({
      now: sonda('Date.now()'),
      semArgumento: sonda('new Date()'),
      comoFuncao: sonda('Date()'),
      nomeMontado: sonda("globalThis['Da' + 'te']['n' + 'ow']()"),
      peloPrototipo: sonda(
        'new (Object.getPrototypeOf(new Date(0)).constructor)()',
      ),
      reflect: sonda('Reflect.construct(Date, [])'),
      intl: sonda("new Intl.DateTimeFormat('pt-BR').format()"),
      intlPartes: sonda(
        "new Intl.DateTimeFormat('pt-BR').formatToParts().length",
      ),
      comArgumento: sonda('new Date(0).getTime()'),
      process: sonda('typeof process'),
      performance: sonda('typeof performance'),
      timers: sonda(
        'typeof setTimeout + typeof queueMicrotask + typeof setImmediate',
      ),
      require: sonda('typeof require'),
    }).toEqual({
      now: 'LANCOU',
      semArgumento: 'LANCOU',
      comoFuncao: 'LANCOU',
      nomeMontado: 'LANCOU',
      peloPrototipo: 'LANCOU',
      reflect: 'LANCOU',
      intl: 'LANCOU',
      intlPartes: 'LANCOU',
      comArgumento: '0',
      process: 'undefined',
      performance: 'undefined',
      timers: 'undefinedundefinedundefined',
      require: 'undefined',
    });
    expect(JSON.parse(r.violacoes())).toHaveLength(8);
  });
});

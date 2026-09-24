import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  opcoesDeCors,
  ORIGENS_DE_DESENVOLVIMENTO,
  MAX_AGE_DO_PREFLIGHT,
} from './cors';

/**
 * **SPEC-070/AC-002 e AC-003 — a FORMA da política, não o efeito dela.**
 *
 * A AC de efeito (o `OPTIONS` por origem, no e2e) derruba as três políticas
 * permissivas — curinga, expressão regular, callback — **porque eu escolhi os
 * quatro negativos certos**. Esta aqui derruba independentemente do que eu
 * imaginei, e é essa a diferença.
 *
 * ## Por que a asserção é sobre o CONJUNTO
 *
 * A versão anterior desta spec preservava `origin` e escrevia *"a mudança de
 * comportamento é zero"*. `credentials: true` podia cair sem ninguém notar, e
 * a autenticação cross-origin por cookie ia junto. **Asserção de preservação é
 * sobre o conjunto, nunca sobre um membro escolhido a dedo** — por isso
 * `violacoesDaForma` compara o conjunto de chaves inteiro, e não uma lista de
 * propriedades que eu lembrasse de citar.
 */

const ESPERADAS = ['credentials', 'maxAge', 'origin'];

/**
 * O verificador, **exposto para poder ser sabotado**.
 *
 * Um teste que só afirma sobre o objeto real prova que ele está certo hoje;
 * não prova que a asserção pegaria o errado. Os casos abaixo alimentam esta
 * função com objetos deliberadamente quebrados.
 */
export function violacoesDaForma(
  opcoes: unknown,
  origensEsperadas: string[],
): string[] {
  const problemas: string[] = [];
  if (typeof opcoes !== 'object' || opcoes === null) {
    return ['não é objeto'];
  }
  const o = opcoes as Record<string, unknown>;

  const chaves = Object.keys(o).sort();
  if (JSON.stringify(chaves) !== JSON.stringify(ESPERADAS)) {
    problemas.push(`chaves: ${chaves.join(', ')}`);
  }
  if (o.credentials !== true) {
    problemas.push(`credentials: ${String(o.credentials)}`);
  }
  if (o.maxAge !== MAX_AGE_DO_PREFLIGHT) {
    problemas.push(`maxAge: ${String(o.maxAge)}`);
  }

  const origin = o.origin;
  if (!Array.isArray(origin)) {
    // Curinga, `RegExp`, callback e string única caem todos aqui — sem que o
    // teste precise adivinhar qual deles alguém usaria.
    problemas.push(
      `origin é ${origin instanceof RegExp ? 'RegExp' : typeof origin}`,
    );
    return problemas;
  }
  if (new Set(origin).size !== origin.length) {
    problemas.push('origin tem duplicata');
  }
  const obtidas = [...origin].sort();
  const queridas = [...new Set(origensEsperadas)].sort();
  // **Sem ordem**: reordenar `CORS_ORIGINS` não muda a política, e AC que fica
  // vermelha para comportamento equivalente é armadilha, não rigor.
  if (JSON.stringify(obtidas) !== JSON.stringify(queridas)) {
    problemas.push(`origin: [${obtidas.join(', ')}]`);
  }
  return problemas;
}

const A = 'https://app.playck.com.br';
const B = 'https://admin.playck.com.br';

describe('AC-002 — a forma e o conteúdo de `opcoesDeCors`', () => {
  it('o objeto real não tem violação', () => {
    const opcoes = opcoesDeCors({ CORS_ORIGINS: `${A},${B}` });
    expect(violacoesDaForma(opcoes, [A, B])).toEqual([]);
  });

  it('e a ordem NÃO é exigida', () => {
    const opcoes = opcoesDeCors({ CORS_ORIGINS: `${B},${A}` });
    expect(violacoesDaForma(opcoes, [A, B])).toEqual([]);
  });

  // **A fixture que DISTINGUE a ordem das operações.** `'a, ,a, '` dá o mesmo
  // resultado sob `trim → vazios → dedupe` e sob `dedupe → trim → vazios`, e
  // por isso não prova nada. Esta prova: deduplicar antes do `trim` deixaria
  // `'https://a'` e `' https://a'` como duas strings diferentes.
  it('deduplica DEPOIS do trim, e esta fixture é a que separa as duas ordens', () => {
    const opcoes = opcoesDeCors({ CORS_ORIGINS: `${A}, ${A}` });
    expect(opcoes.origin).toEqual([A]);
    expect(violacoesDaForma(opcoes, [A])).toEqual([]);
  });

  it('vazios e espaços somem, e a duplicata some junto', () => {
    const opcoes = opcoesDeCors({ CORS_ORIGINS: `${A}, ,${A}, ` });
    expect(opcoes.origin).toEqual([A]);
  });

  // **As sabotagens, e elas são o que torna a AC não-vacuosa.** Cada uma é um
  // objeto que alguém poderia escrever, e a asserção tem de recusar todos.
  it.each([
    ['sem `credentials`', { origin: [A], maxAge: 600 }, 'chaves'],
    [
      'com chave a mais',
      { origin: [A], credentials: true, maxAge: 600, x: 1 },
      'chaves',
    ],
    [
      '`credentials: false`',
      { origin: [A], credentials: false, maxAge: 600 },
      'credentials',
    ],
    ['`maxAge: 0`', { origin: [A], credentials: true, maxAge: 0 }, 'maxAge'],
    [
      'curinga',
      { origin: true, credentials: true, maxAge: 600 },
      'origin é boolean',
    ],
    [
      'string única',
      { origin: A, credentials: true, maxAge: 600 },
      'origin é string',
    ],
    [
      'expressão regular',
      { origin: /playck\.com\.br/, credentials: true, maxAge: 600 },
      'origin é RegExp',
    ],
    [
      'callback',
      { origin: () => true, credentials: true, maxAge: 600 },
      'origin é function',
    ],
    [
      'origem apagada',
      { origin: [A], credentials: true, maxAge: 600 },
      'origin: [',
    ],
    [
      'origem duplicada',
      { origin: [A, A, B], credentials: true, maxAge: 600 },
      'duplicata',
    ],
  ])('%s fica vermelho', (_nome, objeto, marca) => {
    const violacoes = violacoesDaForma(objeto, [A, B]);
    expect(violacoes.join(' | ')).toContain(marca);
  });
});

describe('AC-003 — falha FECHADA', () => {
  // Refletir qualquer origem com `credentials: true` deixaria qualquer site ler
  // resposta autenticada pelo cookie da vítima. Sem a variável, o app recusa a
  // origem real — erro visível no console — em vez de ficar vulnerável calado.
  it.each([
    ['ausente', undefined],
    ['vazia', ''],
    ['só vírgulas e espaços', ' , , '],
  ])(
    '`CORS_ORIGINS` %s devolve a lista de dev, e NUNCA curinga',
    (_n, valor) => {
      const opcoes = opcoesDeCors({ CORS_ORIGINS: valor });
      expect(opcoes.origin).toEqual(ORIGENS_DE_DESENVOLVIMENTO);
      expect(violacoesDaForma(opcoes, ORIGENS_DE_DESENVOLVIMENTO)).toEqual([]);
      expect(opcoes.origin).not.toBe(true);
      expect(opcoes.origin).not.toBe('*');
    },
  );

  it('e o fallback é uma CÓPIA: mexer no resultado não contamina a constante', () => {
    const opcoes = opcoesDeCors({});
    (opcoes.origin as string[]).push('https://invasor.example');
    expect(ORIGENS_DE_DESENVOLVIMENTO).toHaveLength(3);
  });
});

/**
 * **SPEC-070/AC-006, cláusula 2 — o gate de CONJUNTO.**
 *
 * Não é "existe um `enableCors`": é **o conjunto de arquivos de produção que o
 * chamam é exatamente este**. Um segundo `enableCors` em qualquer lugar de
 * `src/` sobrescreveria a política sem que a cláusula 1 percebesse — ela conta
 * chamadas no dublê de UMA fábrica.
 *
 * Arquivos de teste ficam de fora **de propósito, e o limite é declarado**: o
 * `cors-preflight.e2e-spec.ts` chama `enableCors` num módulo mínimo, e é assim
 * que ele prova o efeito. Uma segunda chamada dentro de uma suíte não muda
 * produção.
 */
const CHAMAM_ENABLE_CORS = ['src/common/validation/configurar-app.ts'];

function arquivosQueChamam(raiz: string): string[] {
  const achados: string[] = [];
  const andar = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, item.name);
      if (item.isDirectory()) {
        andar(caminho);
      } else if (item.name.endsWith('.ts') && !item.name.endsWith('.spec.ts')) {
        if (/\.enableCors\(/.test(fs.readFileSync(caminho, 'utf8'))) {
          achados.push(path.relative(raiz, caminho).split(path.sep).join('/'));
        }
      }
    }
  };
  andar(path.join(raiz, 'src'));
  return achados.sort();
}

describe('AC-006 — uma configuração de CORS, e ela é executada', () => {
  it('o conjunto de arquivos de produção que chamam `enableCors` é exato', () => {
    const raiz = path.resolve(__dirname, '..', '..', '..');
    expect(arquivosQueChamam(raiz)).toEqual(CHAMAM_ENABLE_CORS);
  });
});

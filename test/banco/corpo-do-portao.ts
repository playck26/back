/**
 * SPEC-076/AC-030 — o que o db-spec lê do corpo do portão
 * (`PresencaService.travarEValidarOcorrencia`) para provar que ele só tem um
 * relógio: a lista de CHAMADAS que ele faz e o SQL que ele manda.
 *
 * A prova é de lista fechada, e não de busca. Cinco rodadas de validação
 * mostraram que procurar "outro relógio" não termina (alias, helper,
 * callback, dependência): o db-spec compara as chamadas do corpo com uma
 * lista EXATA do que pode ser chamado, e o SQL com o texto EXATO que foi
 * revisado. Qualquer chamada nova — de pacote, de callback, de ORM — muda a
 * lista e derruba o teste, qualquer que seja a forma. A decisão de tempo é
 * `decidirTempoDoPortao`, provada num realm sem relógio no teste de unidade.
 */
import { readFileSync } from 'node:fs';

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

/** O corpo de um método de classe (recuo de dois espaços), com os índices. */
export function corpoDoMetodo(
  arquivo: string,
  nome: string,
): { codigo: string; estrutura: string } {
  const fonte = readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
  const { codigo, estrutura } = lexar(fonte);
  const m = new RegExp(
    `\\n {2}(?:(?:private|public|protected|static|async)\\s+)*${nome}\\s*\\(`,
  ).exec(estrutura);
  if (!m) throw new Error(`método ${nome} não achado`);
  const abre = m.index + m[0].length - 1;
  const fechaParametros = fechamento(estrutura, abre);
  // Depois dos parâmetros vem o tipo de retorno, que pode ter `{`: o corpo é
  // o primeiro `{` no nível zero depois de `)` e de `>` do `Promise<…>`.
  let k = fechaParametros + 1;
  let nivel = 0;
  for (; k < estrutura.length; k += 1) {
    const c = estrutura[k];
    if (c === '<' || c === '(' || c === '[') nivel += 1;
    else if (c === '>' || c === ')' || c === ']') nivel -= 1;
    else if (c === '{') {
      const antes = estrutura.slice(fechaParametros + 1, k).trim();
      if (nivel === 0 && antes.length > 0 && !/[:|&,<]$/.test(antes)) break;
      k = fechamento(estrutura, k);
    }
  }
  const fim = fechamento(estrutura, k);
  return {
    codigo: codigo.slice(k, fim + 1),
    estrutura: estrutura.slice(k, fim + 1),
  };
}

const PALAVRAS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'await',
  'throw',
]);

/**
 * Toda chamada do corpo: `a.b.c(`, `new X(`, e o template marcado
 * `tx.$queryRaw<…>\`` — com os tipos genéricos pulados. Devolve os nomes, na
 * ordem, e marca `new`.
 */
export function chamadasDoCorpo(estrutura: string): string[] {
  const saida: string[] = [];
  const re =
    /(new\s+)?(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*/g;
  for (const m of estrutura.matchAll(re)) {
    const nome = m[2].replace(/\s+/g, '');
    if (PALAVRAS.has(nome)) continue;
    let k = (m.index ?? 0) + m[0].length;
    if (estrutura[k] === '<') {
      // genérico: pula `<…>` balanceado (os `>` de `=>` não aparecem aqui)
      let nivel = 0;
      for (; k < estrutura.length; k += 1) {
        if (estrutura[k] === '<') nivel += 1;
        else if (estrutura[k] === '>') {
          nivel -= 1;
          if (nivel === 0) break;
        }
      }
      k += 1;
      while (/\s/.test(estrutura[k] ?? '')) k += 1;
    }
    if (estrutura[k] === '(' || estrutura[k] === '`') {
      saida.push(
        `${m[1] ? 'new ' : ''}${nome}${estrutura[k] === '`' ? '`' : '('}`,
      );
    }
  }
  return saida;
}

/** O texto de cada template marcado `…$queryRaw\`…\``, com `${…}` como `$`. */
export function sqlDoCorpo(codigo: string, estrutura: string): string[] {
  const saida: string[] = [];
  for (const m of estrutura.matchAll(/\$queryRaw[^`]*`/g)) {
    const inicio = (m.index ?? 0) + m[0].length;
    let k = inicio;
    let texto = '';
    while (k < codigo.length && codigo[k] !== '`') {
      if (codigo[k] === '$' && codigo[k + 1] === '{') {
        k = fechamento(estrutura, k + 1) + 1;
        texto += '$';
        continue;
      }
      texto += codigo[k];
      k += 1;
    }
    saida.push(texto.replace(/\s+/g, ' ').trim());
  }
  return saida;
}

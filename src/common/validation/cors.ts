import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * **SPEC-070 — a política de CORS, numa função pura.**
 *
 * ## Por que ela saiu de dentro do bootstrap
 *
 * A política morava inline, e nenhum teste conseguia **olhar** o objeto. As ACs
 * que tentavam prová-la só podiam afirmar o **efeito** — a resposta HTTP para as
 * origens que o teste lembrasse de tentar —, e isso deixa passar uma política
 * permissiva inteira:
 *
 * | Política | AC de efeito | AC de forma |
 * |---|---|---|
 * | `origin: true` | passa nas origens normativas | **vermelha** |
 * | `origin: /playck\.com\.br/` | passa, e aceita `app.playck.com.br.evil.example` | **vermelha** |
 * | callback que aceita tudo | passa | **vermelha** |
 *
 * A AC de efeito derruba as três **porque eu escolhi os quatro negativos
 * certos**. A de forma derruba independentemente do que eu imaginei — e é essa
 * a diferença que justifica este arquivo existir.
 *
 * ## O que este objeto promete, propriedade por propriedade
 *
 * | Propriedade | Asserção | Sabotagem mínima |
 * |---|---|---|
 * | o conjunto de chaves | exatamente `{origin, credentials, maxAge}` | acrescentar ou remover uma chave |
 * | `credentials` | `true` | `false` |
 * | `maxAge` | `600` | `0` |
 * | `origin` | `Array`, nunca predicado | curinga, `RegExp`, callback |
 * | `origin` | mesmos elementos do conjunto de entrada, sem duplicata | apagar uma origem; duplicar uma |
 *
 * **A ordem NÃO é exigida.** Reordenar `CORS_ORIGINS` não muda a política, e AC
 * que fica vermelha para comportamento equivalente é armadilha, não rigor.
 */

/**
 * Fallback de desenvolvimento, **nunca um curinga**.
 *
 * Refletir qualquer origem combinado com `credentials: true` é o anti-padrão de
 * CORS mais citado pelo OWASP: deixaria qualquer site ler resposta autenticada
 * pelo cookie da vítima. Se `CORS_ORIGINS` faltar em produção por engano, o app
 * **falha fechado** — recusa a origem real, com erro visível no console do
 * navegador — em vez de falhar aberto, vulnerável em silêncio.
 */
export const ORIGENS_DE_DESENVOLVIMENTO = [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
];

/**
 * **Dez minutos, e o verbo importa.**
 *
 * Sem o cabeçalho, o navegador guarda o preflight pelo padrão de **cinco
 * segundos** — janela curta, não ausente. Com ele, **permite reaproveitamento
 * por até** dez minutos: o navegador pode descartar a entrada antes, e teto é
 * permissão, não garantia.
 *
 * E o cache é chaveado **também pela URL**, então isto não elimina os `OPTIONS`
 * de um carregamento frio com URLs diferentes — beneficia a chamada repetida à
 * mesma URL.
 */
export const MAX_AGE_DO_PREFLIGHT = 600;

/**
 * A ordem das operações é **normativa**, e há fixture para ela:
 * `trim` → remoção dos vazios → **deduplicação**.
 *
 * Deduplicar antes do `trim` deixaria `'https://a, https://a'` com duas
 * entradas, porque `'https://a'` e `' https://a'` são strings diferentes.
 */
function origensExatas(bruto: string | undefined): string[] {
  const entradas = (bruto ?? '')
    .split(',')
    .map((origem) => origem.trim())
    .filter(Boolean);
  return [...new Set(entradas)];
}

/**
 * As opções que produção aplica. **Três chaves, e o conjunto é fechado** — a
 * prova compara o conjunto inteiro, e não uma propriedade escolhida a dedo.
 *
 * *Foi exatamente esse o defeito da versão anterior desta spec: ela afirmava
 * "a mudança de comportamento é zero" com uma AC que preservava `origin` e
 * deixava `credentials` cair sem ninguém notar.*
 */
export function opcoesDeCors(env: NodeJS.ProcessEnv): CorsOptions {
  const listadas = origensExatas(env.CORS_ORIGINS);
  return {
    origin: listadas.length > 0 ? listadas : [...ORIGENS_DE_DESENVOLVIMENTO],
    credentials: true,
    maxAge: MAX_AGE_DO_PREFLIGHT,
  };
}

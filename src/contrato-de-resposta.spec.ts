import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-021/TASK-005 — **o gate que faz a dívida encolher, e nunca crescer.**
 *
 * ## Por que um gate, e não só terminar o trabalho
 *
 * Chegar a 90 de 90 não resolve nada sozinho: a rota número 91 nasce sem
 * schema, e o placar volta a cair sem ninguém reparar. **Foi assim que esta
 * dívida se formou** — o Nest só emite schema para corpo de requisição, então
 * "não declarar resposta" é o caminho de menor esforço e o padrão silencioso.
 *
 * O DEF-012 custou três telas em branco no app do aluno em produção. O que o
 * causou não foi um descuido pontual: foi **90 de 90 respostas sem contrato**,
 * durante meses, sem nada acender.
 *
 * ## As duas asserções, e a segunda é a que importa
 *
 * 1. **Rota fora da lista precisa ter schema.** Barra dívida nova.
 * 2. **Rota na lista não pode ter schema.** Barra a lista de apodrecer.
 *
 * A segunda parece burocracia e é o coração disto. Uma lista de exceções que
 * só cresce vira decoração em três meses — todo mundo já viu isso acontecer.
 * Esta obriga quem consertar uma rota a **apagar a linha dela daqui**, e o
 * arquivo passa a medir o progresso em vez de descrevê-lo.
 *
 * ## Por que ler o `openapi.json` e não os decorators
 *
 * O `openapi.json` é o artefato que os três frontends consomem
 * (`gen:api-types`), e o CI já o regenera e falha em `git diff --exit-code`.
 * Conferir os decorators provaria que escrevemos decorators; conferir o
 * `openapi.json` prova **o que o cliente recebe** — que é a única coisa que o
 * DEF-012 teria detectado.
 *
 * ## E não, ele não fica cego com um arquivo desatualizado
 *
 * No `ci.yml`, `pnpm test` roda **antes** de `openapi:export` — então este
 * teste lê o arquivo **commitado**, não um recém-gerado. A pergunta óbvia é
 * se dá para escapar dele esquecendo de regenerar. Não dá, e o par é o que
 * fecha:
 *
 * | Cenário | Quem fica vermelho |
 * |---|---|
 * | rota nova sem schema, `openapi.json` regenerado | **este teste** |
 * | rota nova sem schema, `openapi.json` esquecido | o `git diff --exit-code` do passo `openapi:export` |
 *
 * Nenhum dos dois sozinho cobre os dois casos. Juntos, cobrem.
 *
 * ## `204` não entra na conta
 *
 * Resposta sem corpo não tem schema a declarar, e exigir um seria pedir para
 * alguém inventar um objeto vazio só para calar o teste. `@ApiNoContentResponse()`
 * é a declaração certa ali, e o `204` no `openapi.json` é a prova dela.
 */

/**
 * As operações que **ainda não** declaram schema de resposta, em 2026-08-27.
 *
 * **Esta lista só encolhe.** Cada linha aqui é uma resposta que um frontend
 * hoje descreve à mão — e tipo escrito à mão é o que estava por trás do
 * DEF-012, do DEF-014 e do DEF-015.
 *
 * Ao dar schema a uma delas, **apague a linha**. O teste abaixo falha se você
 * esquecer, e a mensagem diz exatamente qual apagar.
 */
const SEM_SCHEMA_DE_RESPOSTA = new Set<string>([
  // **Vazia desde 2026-08-27, e chegar a zero foi o trabalho da TASK-005.**
  //
  // Nasceu com 17 linhas, no mesmo dia, e encolheu até aqui. Deixar a
  // constante em vez de apagá-la é deliberado: é onde a próxima exceção
  // teria de ser escrita, com nome e data, em vez de acontecer em silêncio.
  //
  // Se você veio parar aqui porque um teste abaixo ficou vermelho, a
  // pergunta certa não é "como calo isto" — é por que a rota nova não
  // declara `@ApiOkResponse`. O DEF-012 custou três telas em branco em
  // produção, e a causa foi exatamente esta lista, implícita e com 90 linhas.
]);

const VERBOS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Resposta {
  content?: Record<string, unknown>;
}
interface Operacao {
  responses?: Record<string, Resposta>;
}
interface OpenApi {
  paths: Record<string, Record<string, Operacao>>;
}

function lerOpenApi(): OpenApi {
  const caminho = join(__dirname, '..', 'openapi.json');
  return JSON.parse(readFileSync(caminho, 'utf8')) as OpenApi;
}

interface Classificada {
  chave: string;
  temSchema: boolean;
  semCorpo: boolean;
}

function classificarOperacoes(): Classificada[] {
  const doc = lerOpenApi();
  const saida: Classificada[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const verbo of VERBOS) {
      const op = ops[verbo];
      if (!op) continue;
      const respostas = op.responses ?? {};
      const temSchema = Object.entries(respostas).some(
        ([codigo, resposta]) =>
          codigo.startsWith('2') &&
          resposta.content !== undefined &&
          Object.keys(resposta.content).length > 0,
      );
      saida.push({
        chave: `${verbo.toUpperCase()} ${path}`,
        temSchema,
        semCorpo: Object.keys(respostas).includes('204'),
      });
    }
  }
  return saida;
}

describe('INV-058/INV-060 — contrato de resposta publicado (SPEC-021)', () => {
  const operacoes = classificarOperacoes();

  it('o openapi.json tem operações — se não tiver, o resto deste arquivo é vácuo', () => {
    // Sem isto, um `openapi.json` truncado faria os dois testes abaixo
    // passarem por vacuidade e o gate viraria decoração silenciosa.
    expect(operacoes.length).toBeGreaterThan(80);
  });

  it('nenhuma rota NOVA nasce sem schema de resposta', () => {
    const devedoras = operacoes
      .filter((o) => !o.temSchema && !o.semCorpo)
      .map((o) => o.chave)
      .filter((chave) => !SEM_SCHEMA_DE_RESPOSTA.has(chave));

    expect(devedoras).toEqual([]);
  });

  /**
   * O teste que impede a lista de apodrecer.
   *
   * Se ele falhar, **a mensagem já diz o que fazer**: apagar as linhas
   * nomeadas de `SEM_SCHEMA_DE_RESPOSTA`. É o único jeito de a lista medir o
   * progresso em vez de só registrar a intenção de um dia fazê-lo.
   */
  it('a lista de exceções não guarda rota que JÁ ganhou schema', () => {
    const resolvidas = operacoes
      .filter(
        (o) =>
          (o.temSchema || o.semCorpo) && SEM_SCHEMA_DE_RESPOSTA.has(o.chave),
      )
      .map((o) => o.chave);

    expect(resolvidas).toEqual([]);
  });

  /**
   * E o que a lista aponta precisa existir. Rota renomeada ou removida deixa
   * uma linha órfã aqui, e linha órfã é dívida fantasma: aumenta o número sem
   * corresponder a nada.
   */
  it('a lista de exceções não guarda rota que não existe mais', () => {
    const existentes = new Set(operacoes.map((o) => o.chave));
    const fantasmas = [...SEM_SCHEMA_DE_RESPOSTA].filter(
      (chave) => !existentes.has(chave),
    );

    expect(fantasmas).toEqual([]);
  });
});

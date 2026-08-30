import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner } from '@nestjs/core';
import { UuidCanonicoPipe } from './uuid-canonico.pipe';

/**
 * GATE — **todo `@Param` de UUID declara o `UuidCanonicoPipe`.**
 *
 * ## Quatro versões deste arquivo já foram achado de validação cruzada
 *
 * | Rodada | O gate perguntava | Passava |
 * |---|---|---|
 * | 4ª | a string `ParseUUIDPipe` não aparece | **tirar** o pipe |
 * | 5ª | `pipes.includes('UuidCanonicoPipe')` no texto | o nome num **comentário** |
 * | 6ª | descoberta por `*.controller.ts` + `/Controller$/` | **renomear** a classe |
 *
 * As três têm a mesma causa: eu perguntava a uma representação do código —
 * string, texto, nome de arquivo — em vez de perguntar ao que o sistema
 * realmente registra.
 *
 * ## Como ele julga agora, e o que ele NÃO julga
 *
 * A descoberta vem do **grafo de módulos**: `AppModule`, seus `imports`
 * transitivos, e os `controllers` que cada um declara. É a mesma lista que o
 * Nest instancia. Renomear classe ou arquivo não some com nada; tirar do
 * módulo some — e some porque a rota deixou de existir, que é o certo.
 *
 * A leitura vem de `ROUTE_ARGS_METADATA`, e a comparação é por **identidade
 * de classe**.
 *
 * **O limite está declarado, e é o achado 2 da 6ª rodada:** isto prova
 * *presença*, não *resultado*. Uma subclasse que sobrescreva `transform` sem
 * normalizar passa aqui; um segundo pipe adiante na cadeia que reverta a
 * grafia também — este gate usa `.some()`, o Nest executa em sequência.
 * **Quem prova resultado é `../validation/fronteira-do-uuid.http.spec.ts`**,
 * por HTTP, no app configurado como produção. As duas metades fazem falta:
 * o gate cobre TODA rota e não vê comportamento; a prova HTTP vê
 * comportamento e cobre uma rota.
 */
type Construtor = new (...args: never[]) => object;
type Modulo = new (...args: never[]) => object;

/** O que o Nest guarda por método em `__routeArguments__`. */
interface ArgumentoDeRota {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

interface ParamEncontrado {
  controller: string;
  metodo: string;
  nome: string;
  temPipe: boolean;
  semNome: boolean;
}

/** Neste projeto, id é `id` ou termina em `Id`. */
const NOME_DE_ID = /^(id|.*Id)$/;

function modulosDe(raiz: Modulo): Set<Modulo> {
  const vistos = new Set<Modulo>();
  const fila: Modulo[] = [raiz];
  while (fila.length > 0) {
    const modulo = fila.pop() as Modulo;
    if (vistos.has(modulo)) continue;
    vistos.add(modulo);

    const importados =
      (Reflect.getMetadata('imports', modulo) as unknown[] | undefined) ?? [];
    for (const importado of importados) {
      // `forRoot`/`forFeature` devolvem módulo dinâmico (`{ module }`).
      const alvo =
        typeof importado === 'function'
          ? (importado as Modulo)
          : ((importado as { module?: Modulo } | null)?.module ?? null);
      if (alvo) fila.push(alvo);
    }
  }
  return vistos;
}

function controllersRegistrados(): Construtor[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../app.module') as { AppModule: Modulo };
  const todos: Construtor[] = [];
  for (const modulo of modulosDe(AppModule)) {
    const declarados =
      (Reflect.getMetadata('controllers', modulo) as
        Construtor[] | undefined) ?? [];
    todos.push(...declarados);
  }
  return todos;
}

/**
 * O `UuidCanonicoPipe` está aplicado **e é o último a tocar no valor**?
 *
 * Classe exata: `p === UuidCanonicoPipe`, ou instância cujo construtor seja
 * exatamente ele. Subclasse não passa — não porque subclasse seja proibida,
 * mas porque este gate não consegue julgar o que ela faz, e um gate que
 * aceita o que não julga é o que produziu quatro achados.
 *
 * E nada depois: qualquer pipe adiante na cadeia pode desfazer a
 * normalização, e a lista é ordenada.
 */
function ehCanonicoEIntacto(pipes: unknown[]): boolean {
  const posicao = pipes.findIndex(
    (p) =>
      p === UuidCanonicoPipe ||
      (typeof p === 'object' &&
        p !== null &&
        p.constructor === UuidCanonicoPipe),
  );
  return posicao !== -1 && posicao === pipes.length - 1;
}

function paramsDoProjeto(): ParamEncontrado[] {
  const todos: ParamEncontrado[] = [];
  for (const Ctor of controllersRegistrados()) {
    // **`MetadataScanner`, e não `getOwnPropertyNames` — achado 1 da 7ª
    // rodada.** É o mesmo scanner que o Nest usa para montar as rotas, e ele
    // percorre a cadeia de protótipos. `CourtSportsController` e
    // `CourtCategoriesController` herdam `update`/`remove` (com `:id`) de
    // `CatalogoController`: o gate via 56 parâmetros onde o Nest registra 60,
    // e tirar o pipe da classe-base deixava tudo verde.
    const metodos = new MetadataScanner()
      .getAllMethodNames(Ctor.prototype as object)
      .filter((m) => m !== 'constructor');
    for (const metodo of metodos) {
      const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Ctor, metodo) as
        Record<string, ArgumentoDeRota> | undefined;
      if (!meta) continue;

      for (const [chave, arg] of Object.entries(meta)) {
        // A chave é `${tipoDoParametro}:${indice}` — só `@Param` interessa.
        if (!chave.startsWith(`${RouteParamtypes.PARAM}:`)) continue;

        todos.push({
          controller: Ctor.name,
          metodo,
          nome: typeof arg.data === 'string' ? arg.data : '',
          // **Identidade EXATA, e nada depois dele — achado 3 da 7ª
          // rodada.** `instanceof` aceitava subclasse que sobrescrevesse
          // `transform` sem normalizar; `.some()` aceitava um segundo pipe
          // adiante que devolvesse a grafia. O Nest executa em sequência: o
          // que vale é o último a tocar no valor.
          temPipe: ehCanonicoEIntacto(arg.pipes ?? []),
          semNome: typeof arg.data !== 'string',
        });
      }
    }
  }
  return todos;
}

describe('gate: a fronteira do UUID de ROTA está declarada', () => {
  const params = paramsDoProjeto();
  const rotulo = (p: ParamEncontrado) =>
    `${p.controller}.${p.metodo}(:${p.nome || '(sem nome)'})`;

  /**
   * Piso duplo: total **e** por controller.
   *
   * O achado 4 da 6ª rodada era um vazio parcial — perder uma classe inteira
   * e o piso global absorver. A descoberta pelo grafo de módulos fecha a
   * causa; esta prova fecha a categoria, cobrando que **todo controller que
   * tem rota com `@Param` apareça**, em vez de confiar num total.
   */
  it('a descoberta enxerga o app inteiro, e não um pedaço', () => {
    expect(controllersRegistrados().length).toBeGreaterThan(15);
    // 60 é o que o `MetadataScanner` acha hoje; o gate via 56 antes do
    // achado 1. O piso subiu junto para que a regressão volte a aparecer.
    expect(params.length).toBeGreaterThanOrEqual(60);

    const comParam = new Set(params.map((p) => p.controller));
    expect(comParam.size).toBeGreaterThan(12);

    // Se nenhum param NÃO-id existisse, a regra do outro lado nunca seria
    // exercitada por dado real.
    expect(
      params.filter((p) => p.nome !== '' && !NOME_DE_ID.test(p.nome)).length,
    ).toBeGreaterThan(0);
  });

  it('todo `@Param` com nome de id declara o `UuidCanonicoPipe`', () => {
    const violacoes = params
      .filter((p) => NOME_DE_ID.test(p.nome))
      .filter((p) => !p.temPipe)
      .map(rotulo);

    expect(violacoes).toEqual([]);
  });

  it('`@Param` que NÃO é id não recebe pipe de UUID', () => {
    const violacoes = params
      .filter((p) => p.nome !== '' && !NOME_DE_ID.test(p.nome))
      .filter((p) => p.temPipe)
      .map(rotulo);

    expect(violacoes).toEqual([]);
  });

  /**
   * `@Param()` sem nome injeta o objeto inteiro e é validado por um DTO —
   * fora do alcance deste gate por construção, e dentro do alcance do gate de
   * corpo. Igualdade, e não piso: se aparecer um terceiro, esta prova cai e
   * obriga a decidir de novo em vez de depender de eu lembrar.
   */
  it('os `@Param()` sem nome continuam sendo só os dois de agenda', () => {
    const semNome = params.filter((p) => p.semNome).map(rotulo);
    expect(semNome).toHaveLength(2);
    expect(semNome.every((r) => r.toLowerCase().includes('agenda'))).toBe(true);
  });
});

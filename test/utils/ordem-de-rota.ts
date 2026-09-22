import type { INestApplication } from '@nestjs/common';

/**
 * SPEC-067/TASK-003 — **a regra do gate de ordem de rota, em funções puras.**
 *
 * O gate propriamente dito está em `test/ordem-de-rota.e2e-spec.ts`. Aqui fica
 * o que ele decide, separado do app montado, para as sabotagens poderem ser
 * feitas com listas de rotas inventadas em vez de com controllers editados.
 *
 * ## Lê o ROTEADOR, não o código-fonte
 *
 * A 1ª rodada de validação desmontou a varredura textual: ela errava a unidade
 * (44 arquivos, 48 classes), não via decorador herdado de classe base, e era
 * enganada por string e por decorador em várias linhas. E já tinha tropeçado
 * sozinha — casou `@Get(':id')` escrito DENTRO de comentário e acusou quatro
 * conflitos falsos, um deles no aviso que o próprio DEF-039 deixou.
 *
 * A tabela de rotas registradas é a que o Express consulta para casar um
 * pedido. **Nada do que enganava o texto sobrevive até ela.**
 */
export type Rota = { metodo: string; caminho: string };

/**
 * **A gramática que a regra de conflito entende — e só ela.**
 *
 * O `path-to-regexp` aceita wildcard, segmento opcional e sufixo de regex, e a
 * regra de conflito abaixo não modela nada disso: um `@Get('*')` registrado
 * antes de qualquer literal engoliria tudo sem o gate notar (achado da 2ª
 * rodada). Modelar a gramática inteira seria perseguir alvo móvel — ela mudou
 * justamente no Express 5. Então ela é **proibida**: o gate recusa o que não
 * entende, em vez de ficar verde sobre isso.
 *
 * Aceito: segmento literal `[A-Za-z0-9._-]+` ou parâmetro `:nome`.
 */
const SEGMENTO_ACEITO = /^(?:[A-Za-z0-9._-]+|:[A-Za-z_][A-Za-z0-9_]*)$/;

const segmentos = (caminho: string) => caminho.split('/').filter(Boolean);

export function gramaticaNaoSuportada(rotas: Rota[]): Rota[] {
  return rotas.filter(
    (r) => !segmentos(r.caminho).every((s) => SEGMENTO_ACEITO.test(s)),
  );
}

const MESMO_METODO = (a: string, b: string) =>
  a === b || a === '_all' || b === '_all';

/**
 * Uma rota registrada **depois** nunca é alcançada se alguma registrada
 * **antes**, do mesmo método, a casa: mesma quantidade de segmentos, e em cada
 * posição ou os dois são o mesmo literal, ou o da primeira é parâmetro.
 *
 * É o DEF-039: `GET /me/classes/:id` registrada antes de
 * `GET /me/classes/anteriores` — o Express casava o `:id`, o pipe de UUID
 * recebia a palavra `anteriores` e respondia 400 numa rota que existia.
 */
export function conflitosDeOrdem(rotas: Rota[]): string[] {
  const achados: string[] = [];
  for (let i = 0; i < rotas.length; i += 1) {
    for (let j = i + 1; j < rotas.length; j += 1) {
      const antes = rotas[i];
      const depois = rotas[j];
      if (!MESMO_METODO(antes.metodo, depois.metodo)) continue;
      const sa = segmentos(antes.caminho);
      const sd = segmentos(depois.caminho);
      if (sa.length !== sd.length) continue;
      if (sa.every((s, k) => s === sd[k] || s.startsWith(':'))) {
        achados.push(
          `${depois.metodo.toUpperCase()} ${depois.caminho} nunca e alcancada: ` +
            `${antes.metodo.toUpperCase()} ${antes.caminho} foi registrada antes e a casa`,
        );
      }
    }
  }
  return achados;
}

type Camada = { route?: { path: string; methods: Record<string, boolean> } };
type Servidor = { _router?: { stack: Camada[] }; router?: { stack: Camada[] } };

/** As rotas registradas, na ordem em que o Express as consulta. */
export function lerRoteador(app: INestApplication): Rota[] {
  const servidor = app.getHttpAdapter().getInstance() as Servidor;
  // Express 4 expunha `_router`; o 5 (Nest 11) expõe `router`.
  const pilha = servidor._router?.stack ?? servidor.router?.stack ?? [];
  return pilha
    .filter((c) => c.route)
    .flatMap((c) =>
      Object.keys(c.route!.methods).map((metodo) => ({
        metodo,
        caminho: c.route!.path,
      })),
    );
}

/**
 * Monta o app e lê o roteador — e, **se o app não subir, diz isso**.
 *
 * Ressalva da 3ª rodada: se o módulo não subir por outro motivo, o gate não
 * pode parecer acusar ordem de rota. A mensagem começa por `O APP NAO SUBIU`, e
 * nunca menciona conflito.
 */
export async function rotasDoApp(
  montar: () => Promise<INestApplication>,
): Promise<Rota[]> {
  let app: INestApplication;
  try {
    app = await montar();
  } catch (erro) {
    throw new Error(
      `O APP NAO SUBIU -- o gate de rota nao chegou a ler o roteador, e isto ` +
        `NAO e um problema de ordem: ${(erro as Error).message}`,
    );
  }
  try {
    return lerRoteador(app);
  } finally {
    await app.close();
  }
}

/**
 * SPEC-083/AC-056 — **o classificador de amostras e o agregado das três
 * tentativas**, que decidem o tempo do FIT-057 (AC-045 e AC-050).
 *
 * ## Por que o término é um intervalo, e não um ponto (DOR-083-R5-01)
 *
 * Uma conexão observadora consulta `pg_stat_activity` do `pid` da importação a
 * cada 20 ms. A última amostra com o backend ainda `active` (**L**) é um
 * **limite inferior** do término real T: a instrução ainda corria ali. A
 * primeira amostra seguinte fora de `active` (**U**) é um **limite superior**:
 * a instrução já tinha acabado. T está entre L e U, e nenhuma das duas pontas,
 * sozinha, diz em que lado do limite ele caiu.
 *
 * Daí as três respostas:
 *
 * - **verde**: `U − início ≤ 2,3 s`. O limite superior está dentro, então T
 *   também está;
 * - **vermelho**: `L − início > 2,3 s`. O limite inferior já passou, então T
 *   também passou — é atraso real, e não do observador;
 * - **inconclusivo**: `L ≤ 2,3 s < U`. O intervalo atravessa o limite. É
 *   **falha do harness**: nunca verde, e nunca acusação de atraso.
 *
 * A regra da v6 (verde se L ≤ 2,3 s) é a S19: ela aprovava a sequência do
 * validador da 5ª rodada, com T real em 2,4 s escondido no vão entre L e U.
 *
 * ## Onde L e U são procurados
 *
 * **Só depois da amostra que viu a segunda espera.** As duas esperas são numa
 * instrução só (a das turmas no AC-045, o `INSERT` de usuários no AC-050) e,
 * entre uma espera e a outra, o backend continua `active`. Antes dessa
 * instrução, porém, ele passa por `idle in transaction` entre uma instrução e
 * outra da transação — e uma amostra nesse vão, tomada como U, daria um verde
 * com o término real ainda por vir.
 *
 * ## O que não é veredito
 *
 * - **precondição de cobertura**: a primeira espera, a segunda depois dela, e
 *   uma amostra terminada depois da segunda. Sem as três, o caso reprova pela
 *   precondição, e nunca com um tempo aparentemente bom (a S18 é o harness que
 *   para de amostrar depois da primeira espera);
 * - **vão acima de 200 ms** entre duas amostras: a tentativa é falha do
 *   harness. Exatamente 200 ms ainda vale (a sequência do validador tem esse
 *   vão, e é inconclusiva pelo intervalo, e não pelo vão).
 *
 * **Nenhum import do banco ou do Nest**: a unidade (`classificar-amostras.spec.ts`)
 * prova este arquivo com sequências fixas, e o FIT-057 importa as mesmas
 * funções. Um classificador para o teste e outro para o FIT seriam dois.
 */

/** AC-045 e AC-050 — o limite de desistência, contado do início. */
export const LIMITE_DE_DESISTENCIA_MS = 2_300;

/**
 * AC-045 e AC-050, com a S10 ou a S12 aplicada — **a assinatura tardia**: uma
 * amostra ainda `active` depois de 3 s. Como L é limite inferior de T, ela
 * prova o atraso do mecanismo sabotado, e não um soluço do observador.
 */
export const ASSINATURA_TARDIA_MS = 3_000;

/** Validade do harness: acima disto entre duas amostras, não há veredito. */
export const VAO_MAXIMO_MS = 200;

/** A cadência do observador (a folga até o vão máximo é a margem dele). */
export const CADENCIA_MS = 20;

/** Por quem a amostra viu a importação esperando, já traduzido pelo harness. */
export type Espera = 'primeira' | 'segunda' | null;

export interface Amostra {
  /** Milissegundos desde o início (`playck.prazo − 2 s`), no relógio do servidor. */
  ms: number;
  /** O `state` de `pg_stat_activity`; nulo se o `pid` já não estava lá. */
  state: string | null;
  /**
   * `primeira` quando o `pg_blocking_pids` da amostra aponta quem segura o
   * primeiro recurso (X), `segunda` quando aponta quem segura o segundo (Y).
   */
  espera: Espera;
}

export type Veredito = 'verde' | 'inconclusivo' | 'vermelho';

interface Medidas {
  /** O maior intervalo entre duas amostras seguidas, registrado sempre. */
  maiorVao: number;
  amostras: number;
}

export type Classificacao =
  | (Medidas & {
      tipo: 'veredito';
      veredito: Veredito;
      /** A última amostra `active` depois da segunda espera. */
      L: number;
      /** A primeira amostra fora de `active` depois de L. */
      U: number;
      /** `L ≥ 3 s` — a única forma de vermelho que prova a S10 e a S12. */
      assinaturaTardia: boolean;
    })
  | (Medidas & {
      tipo: 'falha_do_harness';
      motivo: string;
      L: number;
      U: number;
    })
  | (Medidas & { tipo: 'precondicao'; motivo: string });

const ATIVO = 'active';

function maiorVaoDe(amostras: readonly Amostra[]): number {
  let maior = 0;
  for (let i = 1; i < amostras.length; i++) {
    maior = Math.max(maior, amostras[i].ms - amostras[i - 1].ms);
  }
  return maior;
}

/**
 * Classifica **uma** tentativa. A ordem das perguntas é a da spec:
 * precondição de cobertura, validade do harness, e só então o tempo.
 */
export function classificarAmostras(
  amostras: readonly Amostra[],
): Classificacao {
  const medidas: Medidas = {
    maiorVao: maiorVaoDe(amostras),
    amostras: amostras.length,
  };

  const iPrimeira = amostras.findIndex((a) => a.espera === 'primeira');
  if (iPrimeira < 0) {
    return {
      ...medidas,
      tipo: 'precondicao',
      motivo:
        'a primeira espera (por quem segura o primeiro recurso) nunca foi vista',
    };
  }
  // A segunda espera vale só DEPOIS da primeira: uma espera por Y antes da
  // por X é a ordem invertida (S14), e não cobertura.
  const iSegunda = amostras.findIndex(
    (a, i) => i > iPrimeira && a.espera === 'segunda',
  );
  if (iSegunda < 0) {
    return {
      ...medidas,
      tipo: 'precondicao',
      motivo: 'a segunda espera nunca foi vista depois da primeira',
    };
  }
  const iU = amostras.findIndex((a, i) => i > iSegunda && a.state !== ATIVO);
  if (iU < 0) {
    return {
      ...medidas,
      tipo: 'precondicao',
      motivo:
        'nenhuma amostra depois da segunda espera mostra a operação terminada',
    };
  }

  // Todas as amostras de iSegunda a iU − 1 estão `active` (iU é a primeira
  // que não está), então L é a imediatamente anterior a U.
  const L = amostras[iU - 1].ms;
  const U = amostras[iU].ms;

  if (medidas.maiorVao > VAO_MAXIMO_MS) {
    return {
      ...medidas,
      tipo: 'falha_do_harness',
      motivo: `vão de ${medidas.maiorVao.toFixed(0)} ms entre amostras (máximo ${VAO_MAXIMO_MS} ms)`,
      L,
      U,
    };
  }

  const veredito: Veredito =
    U <= LIMITE_DE_DESISTENCIA_MS
      ? 'verde'
      : L > LIMITE_DE_DESISTENCIA_MS
        ? 'vermelho'
        : 'inconclusivo';
  return {
    ...medidas,
    tipo: 'veredito',
    veredito,
    L,
    U,
    assinaturaTardia: L >= ASSINATURA_TARDIA_MS,
  };
}

export type Agregado = 'aprova' | 'reprova' | 'falha_do_harness';

/** Exatamente três tentativas (AC-045). */
export const TENTATIVAS = 3;

/**
 * SPEC-083/AC-056 — **o agregado conservador das três tentativas**
 * (DOR-083-R6-01 e DOR-083-R7-01):
 *
 * - vermelho em **qualquer** posição ⇒ reprova, e prevalece sobre o
 *   inconclusivo;
 * - senão, inconclusivo em **qualquer** posição ⇒ falha do harness;
 * - só verde, verde, verde aprova.
 *
 * *Por que uma inconclusiva não é compensada por verdes:* o argumento "U vem
 * depois de T" vale dentro da tentativa verde, e não passa para outra
 * execução. A inconclusiva pode esconder um atraso real.
 *
 * Recebe as três, e não "as que houver": agregar só as duas primeiras (S21)
 * aprovaria verde, verde, vermelho.
 */
export function agregarTentativas(vereditos: readonly Veredito[]): Agregado {
  if (vereditos.length !== TENTATIVAS) {
    throw new Error(
      `agregarTentativas: exatamente ${TENTATIVAS} tentativas, e vieram ${vereditos.length}`,
    );
  }
  if (vereditos.includes('vermelho')) return 'reprova';
  if (vereditos.includes('inconclusivo')) return 'falha_do_harness';
  return 'aprova';
}

/**
 * O que o FIT-057 conclui das três classificações, com o motivo em texto.
 *
 * - precondição em qualquer tentativa ⇒ **reprova pela precondição**, e o
 *   motivo diz qual — nunca um tempo;
 * - vão acima do máximo conta como inconclusivo: as duas são falha do
 *   harness, e as duas perdem para um vermelho de outra tentativa;
 * - o resto é o `agregarTentativas`.
 */
export function concluirCaso(classificacoes: readonly Classificacao[]): {
  agregado: Agregado;
  motivo: string;
} {
  const semCobertura = classificacoes.findIndex(
    (c) => c.tipo === 'precondicao',
  );
  if (semCobertura >= 0) {
    const c = classificacoes[semCobertura] as { motivo: string };
    return {
      agregado: 'reprova',
      motivo: `precondição de cobertura na tentativa ${semCobertura + 1}: ${c.motivo}`,
    };
  }
  const vereditos = classificacoes.map((c): Veredito =>
    c.tipo === 'veredito' ? c.veredito : 'inconclusivo',
  );
  const agregado = agregarTentativas(vereditos);
  return {
    agregado,
    motivo: `vereditos ${vereditos.join(', ')} ⇒ ${agregado}`,
  };
}

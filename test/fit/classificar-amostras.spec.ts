/**
 * SPEC-083/AC-056 — **o classificador de amostras recusa o falso verde**, e o
 * agregado das três tentativas é o conservador.
 *
 * Sequências fixas, escritas à mão: nenhuma sai do banco, e nenhuma depende do
 * relógio da máquina. É aqui que a S19 (o classificador da v6), a S20 (o
 * agregado da v7) e a S21 (o agregado das duas primeiras) ficam vermelhas — o
 * FIT-057 importa estas mesmas funções, e o tempo dele só vale o que elas
 * valem.
 *
 * ## Onde roda
 *
 * O nome é `.spec.ts`, como a spec manda, e a unitária olha só `src/`. Quem
 * acha este arquivo é o `testRegex` do `jest-fit.json`, **pelo nome** (TASK-005c):
 * ele roda no `fit-critical` (`pnpm run test:fit`) como arquivo próprio, ao
 * lado do FIT-057, que importa só as funções. Antes, vinha por um `import` do
 * FIT-057 — rodava só porque o FIT rodava, e contava como caso dele.
 *
 * À mão, sem o resto do FIT (o `globalSetup` do jest-fit ainda exige o banco):
 *
 * `.\node_modules\.bin\jest.CMD --config ./test/jest-fit.json --runInBand classificar-amostras`
 */
import {
  agregarTentativas,
  classificarAmostras,
  concluirCaso,
  TENTATIVAS,
  type Agregado,
  type Amostra,
  type Classificacao,
  type Veredito,
} from './classificar-amostras';

// ==========================================================================
// O construtor das sequências
// ==========================================================================

/** As três formas de `state` que importam ao classificador. */
const ATIVO = 'active';
const ENTRE_INSTRUCOES = 'idle in transaction';
const ABORTADA = 'idle in transaction (aborted)';

interface Roteiro {
  /** A primeira amostra (ms). */
  de?: number;
  /** A cadência (ms). */
  passo?: number;
  /** Até onde as amostras ficam em `idle in transaction`, antes da instrução. */
  ociosaAte?: number;
  /** Quando a espera por X acaba e começa a por Y (ms). */
  trocaEm?: number;
  /** A última amostra `active` (L). */
  ultimaAtiva: number;
  /** A primeira amostra terminada (U); `null` = o harness parou antes. */
  primeiraFora: number | null;
  /** Sem a segunda espera: o backend espera X até o fim (S18, S14). */
  semSegunda?: boolean;
}

/**
 * Amostras a cada `passo` ms, de `de` a `ultimaAtiva`: primeiro
 * `idle in transaction` (o vão antes da instrução), depois `active` esperando
 * X, depois `active` esperando Y; e a amostra `primeiraFora`, já terminada.
 */
function sequencia(r: Roteiro): Amostra[] {
  const passo = r.passo ?? 20;
  const ociosaAte = r.ociosaAte ?? -1;
  const trocaEm = r.trocaEm ?? 1_500;
  const amostras: Amostra[] = [];
  for (let ms = r.de ?? 0; ms <= r.ultimaAtiva; ms += passo) {
    if (ms <= ociosaAte) {
      amostras.push({ ms, state: ENTRE_INSTRUCOES, espera: null });
    } else {
      amostras.push({
        ms,
        state: ATIVO,
        espera: ms < trocaEm || r.semSegunda ? 'primeira' : 'segunda',
      });
    }
  }
  if (r.primeiraFora !== null) {
    amostras.push({ ms: r.primeiraFora, state: ABORTADA, espera: null });
  }
  return amostras;
}

function veredito(c: Classificacao) {
  if (c.tipo !== 'veredito') {
    throw new Error(
      `esperava veredito, e veio ${c.tipo}: ${JSON.stringify(c)}`,
    );
  }
  return c;
}

// ==========================================================================
// classificarAmostras — os sete casos do AC-056
// ==========================================================================

describe('SPEC-083/AC-056 — classificarAmostras', () => {
  it('a sequência do validador da 5ª rodada (L 2.280 ms, U 2.480 ms) é INCONCLUSIVA, e não verde', () => {
    // Amostras a cada 20 ms até 2.280, X antes de 1.500 e Y depois, e a
    // seguinte em 2.480 já terminada. O término real pode ser 2.400 ms: a
    // regra da v6 (S19), que só olhava L, aprovava isto.
    const amostras = sequencia({ ultimaAtiva: 2_280, primeiraFora: 2_480 });
    expect(amostras.filter((a) => a.espera === 'primeira').at(-1)?.ms).toBe(
      1_480,
    );
    expect(amostras.find((a) => a.espera === 'segunda')?.ms).toBe(1_500);

    const c = veredito(classificarAmostras(amostras));
    expect(c.veredito).toBe('inconclusivo');
    expect(c.L).toBe(2_280);
    expect(c.U).toBe(2_480);
    // O vão é de exatamente 200 ms — no limite, e não acima dele: o
    // inconclusivo vem do intervalo, e não da validade do harness.
    expect(c.maiorVao).toBe(200);
  });

  it('U em 2.160 ms é VERDE', () => {
    const c = veredito(
      classificarAmostras(
        sequencia({ ultimaAtiva: 2_140, primeiraFora: 2_160 }),
      ),
    );
    expect(c.veredito).toBe('verde');
    expect(c.U).toBe(2_160);
    expect(c.assinaturaTardia).toBe(false);
  });

  it('L em 2.400 ms é VERMELHO, sem assinatura tardia', () => {
    const c = veredito(
      classificarAmostras(
        sequencia({ ultimaAtiva: 2_400, primeiraFora: 2_420 }),
      ),
    );
    expect(c.veredito).toBe('vermelho');
    expect(c.L).toBe(2_400);
    expect(c.assinaturaTardia).toBe(false);
  });

  it('L em 3.100 ms é VERMELHO com a assinatura tardia (a forma que prova a S10 e a S12)', () => {
    const c = veredito(
      classificarAmostras(
        sequencia({ ultimaAtiva: 3_100, primeiraFora: 3_120 }),
      ),
    );
    expect(c.veredito).toBe('vermelho');
    expect(c.L).toBe(3_100);
    expect(c.assinaturaTardia).toBe(true);
  });

  // A borda da assinatura tardia (TASK-005c): a spec diz `L − início ≥ 3 s`.
  // Com só o 3.100, um `>` no lugar do `>=` passava; o 3.000 o pega, e o
  // 2.999 pega o limite deslocado para baixo.
  it('L em exatamente 3.000 ms já é a assinatura tardia (L − início ≥ 3 s, com o igual)', () => {
    const c = veredito(
      classificarAmostras(
        sequencia({ ultimaAtiva: 3_000, primeiraFora: 3_020 }),
      ),
    );
    expect(c.veredito).toBe('vermelho');
    expect(c.L).toBe(3_000);
    expect(c.assinaturaTardia).toBe(true);
  });

  it('L em 2.999 ms é vermelho, mas SEM a assinatura tardia', () => {
    // Amostras em 19, 39, …, 2.999: a cadência de 20 ms, deslocada para a
    // última `active` cair 1 ms antes dos 3 s.
    const c = veredito(
      classificarAmostras(
        sequencia({ de: 19, ultimaAtiva: 2_999, primeiraFora: 3_019 }),
      ),
    );
    expect(c.veredito).toBe('vermelho');
    expect(c.L).toBe(2_999);
    expect(c.assinaturaTardia).toBe(false);
  });

  it('um vão de 250 ms entre amostras é FALHA DO HARNESS, mesmo com um U que daria verde', () => {
    const antes = sequencia({ ultimaAtiva: 1_000, primeiraFora: null });
    const depois = sequencia({
      de: 1_250,
      ultimaAtiva: 2_140,
      primeiraFora: 2_160,
    });
    const c = classificarAmostras([...antes, ...depois]);
    expect(c.tipo).toBe('falha_do_harness');
    expect(c.maiorVao).toBe(250);
  });

  it('sem a segunda espera vista, a PRECONDIÇÃO de cobertura falha — e nunca sai um tempo (S18)', () => {
    // O término em 2.120 ms daria verde, se o classificador o aceitasse.
    const c = classificarAmostras(
      sequencia({ ultimaAtiva: 2_100, primeiraFora: 2_120, semSegunda: true }),
    );
    expect(c.tipo).toBe('precondicao');
  });

  it('a amostragem que parou depois da primeira espera também reprova pela precondição (a S18 como ela é)', () => {
    const c = classificarAmostras(
      sequencia({ ultimaAtiva: 1_480, primeiraFora: null }),
    );
    expect(c.tipo).toBe('precondicao');
  });

  it('uma amostra `idle in transaction` ANTES da segunda espera (o vão entre duas instruções) não é tomada como U', () => {
    // Antes da instrução das turmas (ou do INSERT de usuários), o backend
    // passa por `idle in transaction`. Um classificador que tomasse a
    // primeira amostra fora de `active` como U diria "verde" em 40 ms — com o
    // término real em 2,4 s.
    const amostras = sequencia({
      ociosaAte: 40,
      ultimaAtiva: 2_400,
      primeiraFora: 2_420,
    });
    expect(amostras[0].state).toBe(ENTRE_INSTRUCOES);

    const c = veredito(classificarAmostras(amostras));
    expect(c.veredito).toBe('vermelho');
    expect(c.U).toBe(2_420);
  });

  it('uma amostra fora de `active` entre a primeira e a segunda espera também não é U', () => {
    const amostras = sequencia({ ultimaAtiva: 2_400, primeiraFora: 2_420 });
    const i = amostras.findIndex((a) => a.ms === 1_000);
    amostras[i] = { ms: 1_000, state: ENTRE_INSTRUCOES, espera: null };

    const c = veredito(classificarAmostras(amostras));
    expect(c.veredito).toBe('vermelho');
    expect(c.U).toBe(2_420);
  });

  it('a espera por Y antes da por X (a ordem invertida da S14) não cobre a segunda espera', () => {
    const invertida = sequencia({
      ultimaAtiva: 2_100,
      primeiraFora: 2_120,
    }).map((a): Amostra => ({
      ...a,
      espera:
        a.espera === 'primeira'
          ? 'segunda'
          : a.espera === 'segunda'
            ? 'primeira'
            : null,
    }));
    expect(classificarAmostras(invertida).tipo).toBe('precondicao');
  });

  it('nas bordas: U em 2.300 ms é verde; L em 2.300 ms com U depois é inconclusivo', () => {
    expect(
      veredito(
        classificarAmostras(
          sequencia({ ultimaAtiva: 2_280, primeiraFora: 2_300 }),
        ),
      ).veredito,
    ).toBe('verde');
    expect(
      veredito(
        classificarAmostras(
          sequencia({ ultimaAtiva: 2_300, primeiraFora: 2_320 }),
        ),
      ).veredito,
    ).toBe('inconclusivo');
  });
});

// ==========================================================================
// agregarTentativas — a tabela completa das 27 triplas (DOR-083-R7-01)
// ==========================================================================

/**
 * **Literal**, e não calculada pela mesma regra (que levaria o defeito junto).
 * V = verde, I = inconclusivo, R = vermelho. A precedência: R em qualquer
 * posição ⇒ reprova; senão, I em qualquer posição ⇒ falha do harness; só
 * V, V, V aprova.
 */
const TABELA: readonly [string, Agregado][] = [
  ['VVV', 'aprova'],
  ['VVI', 'falha_do_harness'],
  ['VVR', 'reprova'],
  ['VIV', 'falha_do_harness'],
  ['VII', 'falha_do_harness'],
  ['VIR', 'reprova'],
  ['VRV', 'reprova'],
  ['VRI', 'reprova'],
  ['VRR', 'reprova'],
  ['IVV', 'falha_do_harness'],
  ['IVI', 'falha_do_harness'],
  ['IVR', 'reprova'],
  ['IIV', 'falha_do_harness'],
  ['III', 'falha_do_harness'],
  ['IIR', 'reprova'],
  ['IRV', 'reprova'],
  ['IRI', 'reprova'],
  ['IRR', 'reprova'],
  ['RVV', 'reprova'],
  ['RVI', 'reprova'],
  ['RVR', 'reprova'],
  ['RIV', 'reprova'],
  ['RII', 'reprova'],
  ['RIR', 'reprova'],
  ['RRV', 'reprova'],
  ['RRI', 'reprova'],
  ['RRR', 'reprova'],
];

const LETRA: Record<string, Veredito> = {
  V: 'verde',
  I: 'inconclusivo',
  R: 'vermelho',
};
const tripla = (s: string) => [...s].map((l) => LETRA[l]);

describe('SPEC-083/AC-056 — agregarTentativas, na tabela completa', () => {
  it('a tabela tem as 27 triplas, cada uma uma vez (cobertura, e não resultado)', () => {
    const chaves = new Set(TABELA.map(([t]) => t));
    expect(TABELA).toHaveLength(27);
    expect(chaves.size).toBe(27);
    for (const a of 'VIR')
      for (const b of 'VIR')
        for (const c of 'VIR') expect(chaves.has(a + b + c)).toBe(true);
  });

  it.each(TABELA)('%s ⇒ %s', (t, esperado) => {
    expect(agregarTentativas(tripla(t))).toBe(esperado);
  });

  // Os contraexemplos das rodadas, nomeados.
  it('6ª rodada: verde, inconclusivo, verde é falha do harness, e não aprovação (S20)', () => {
    expect(agregarTentativas(['verde', 'inconclusivo', 'verde'])).toBe(
      'falha_do_harness',
    );
  });

  it('7ª rodada: verde, verde, vermelho reprova — o defeito só na terceira posição (S21)', () => {
    expect(agregarTentativas(['verde', 'verde', 'vermelho'])).toBe('reprova');
  });

  it('7ª rodada: verde, verde, inconclusivo é falha do harness (S21)', () => {
    expect(agregarTentativas(['verde', 'verde', 'inconclusivo'])).toBe(
      'falha_do_harness',
    );
  });

  it('vermelho, inconclusivo, verde reprova: o vermelho prevalece sobre o inconclusivo', () => {
    expect(agregarTentativas(['vermelho', 'inconclusivo', 'verde'])).toBe(
      'reprova',
    );
  });

  it(`exatamente ${TENTATIVAS} tentativas: duas ou quatro não se agregam`, () => {
    expect(() => agregarTentativas(['verde', 'verde'])).toThrow(/exatamente 3/);
    expect(() =>
      agregarTentativas(['verde', 'verde', 'verde', 'verde']),
    ).toThrow(/exatamente 3/);
  });
});

// ==========================================================================
// concluirCaso — o que o FIT-057 faz com as três classificações
// ==========================================================================

describe('SPEC-083/AC-045 e AC-050 — concluirCaso', () => {
  const verde = classificarAmostras(
    sequencia({ ultimaAtiva: 2_140, primeiraFora: 2_160 }),
  );
  const inconclusiva = classificarAmostras(
    sequencia({ ultimaAtiva: 2_280, primeiraFora: 2_480 }),
  );
  const vermelha = classificarAmostras(
    sequencia({ ultimaAtiva: 2_400, primeiraFora: 2_420 }),
  );
  const comVao = classificarAmostras([
    ...sequencia({ ultimaAtiva: 1_000, primeiraFora: null }),
    ...sequencia({ de: 1_250, ultimaAtiva: 2_140, primeiraFora: 2_160 }),
  ]);
  const semCobertura = classificarAmostras(
    sequencia({ ultimaAtiva: 2_100, primeiraFora: 2_120, semSegunda: true }),
  );

  it('três verdes aprovam', () => {
    expect(concluirCaso([verde, verde, verde]).agregado).toBe('aprova');
  });

  it('o vão acima do máximo é falha do harness, e perde para um vermelho', () => {
    expect(concluirCaso([verde, comVao, verde]).agregado).toBe(
      'falha_do_harness',
    );
    expect(concluirCaso([comVao, verde, vermelha]).agregado).toBe('reprova');
  });

  it('a inconclusiva na terceira posição não é compensada pelas duas verdes', () => {
    expect(concluirCaso([verde, verde, inconclusiva]).agregado).toBe(
      'falha_do_harness',
    );
  });

  it('a precondição reprova, e o motivo diz qual tentativa — nunca um tempo', () => {
    const r = concluirCaso([verde, verde, semCobertura]);
    expect(r.agregado).toBe('reprova');
    expect(r.motivo).toMatch(/precondição de cobertura na tentativa 3/);
  });
});

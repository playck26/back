import {
  FOLGA_DO_TIMEOUT_MS,
  LATENCIA_DE_ORCAMENTO_MS,
  PRAZO_DA_MATRICULA_MS,
  TIMEOUT_DA_MATRICULA_MS,
} from '../common/lock/prazo-de-espera';
import {
  clienteContado,
  RAMO_MAIS_CARO,
  type Cenario,
} from '../../test/utils/cliente-contado-da-matricula';

/**
 * SPEC-082/REQ-005 (AC-011) e REQ-003 (AC-014) — **o teto de idas das três
 * transações leitoras, e o tempo-limite que cabe nele por construção.**
 *
 * No molde do `def-013-orcamento-da-transacao.spec.ts`: os serviços são os de
 * verdade, e o dublê é só o cliente de transação, que registra cada ida
 * (`test/utils/cliente-contado-da-matricula.ts`). Conta **`BEGIN` e `COMMIT`**,
 * como a medição do State (log do Postgres, só a conexão da transação).
 *
 * **O ramo mais caro é precondição, e é afirmado ANTES do teto** (achado
 * 082-V2-01): um teste que premiasse o ramo barato passaria com o aviso ao
 * gestor arrancado. Por isso o cenário tem gestor ativo, aluno com nível
 * próprio, ocorrência futura na turma e limite de turmas no clube — e o teste
 * confere que cada um deles foi percorrido.
 *
 * **Os tetos são do ramo mais caro contado no código** (State, 2ª rodada):
 * `allocateStudent` 13, `entrar` 17, `confirmar` 20. A instrução única das
 * travas substitui a ida da trava de antes; o prazo vai dentro das instruções
 * de trava que já existiam; a leitura de fora do D5 fica fora da transação.
 * Nenhum dos três soma.
 */

const TETOS = { allocateStudent: 13, entrar: 17, confirmar: 20 } as const;

type Caminho = keyof typeof TETOS;

async function percorrer(caminho: Caminho, cenario: Cenario = RAMO_MAIS_CARO) {
  const cliente = clienteContado(cenario);
  await cliente[caminho]();
  return cliente;
}

describe('SPEC-082/AC-011 — o teto de idas, no ramo mais caro', () => {
  describe('precondição: o ramo mais caro foi percorrido', () => {
    it.each(['entrar', 'confirmar'] as const)(
      '%s: o aviso ao gestor gravou uma linha em notificacoes por gestor ativo, dentro da transação',
      async (caminho) => {
        const cliente = await percorrer(caminho);

        expect(cliente.gestores.length).toBeGreaterThan(0);
        expect(cliente.linhasEmNotificacoes()).toBe(cliente.gestores.length);
        // Dentro da transação: entre o BEGIN e o COMMIT.
        const rotulos = cliente.idas.map((i) =>
          i.sql && /INSERT\s+INTO\s+notificacoes/.test(i.sql)
            ? 'aviso'
            : i.rotulo,
        );
        expect(rotulos.indexOf('BEGIN')).toBeLessThan(rotulos.indexOf('aviso'));
        expect(rotulos.indexOf('aviso')).toBeLessThan(
          rotulos.lastIndexOf('COMMIT'),
        );
      },
    );

    it.each(['entrar', 'allocateStudent', 'confirmar'] as const)(
      '%s: nível próprio, ocorrência futura e (no aluno) o limite foram lidos',
      async (caminho) => {
        const cliente = await percorrer(caminho);
        const rotulos = cliente.idas.map((i) => i.rotulo);

        // nível próprio: o `nivel.findFirst` pelo id do aluno
        expect(rotulos).toContain('nivel.findFirst');
        // ocorrência futura: os três conjuntos da aula foram carregados
        expect(rotulos).toContain('faltaAvisada.findMany');
        expect(rotulos).toContain('reposicaoDeAula.findMany');
        // a matrícula foi gravada (o ramo não parou numa recusa)
        expect(
          cliente.idas.some((i) =>
            i.sql?.trimStart().startsWith('/* matricula-com-prazo */'),
          ),
        ).toBe(true);
        if (caminho !== 'allocateStudent') {
          // o limite de turmas conta as matrículas do aluno (SPEC-023: o
          // gestor não confere limite)
          expect(rotulos).toContain('empresa.findUniqueOrThrow');
          expect(
            cliente.idas.filter((i) => i.rotulo === 'turmaAluno.count'),
          ).toHaveLength(2);
        }
      },
    );
  });

  it.each(Object.entries(TETOS) as [Caminho, number][])(
    '%s cabe no teto de %i idas (com BEGIN e COMMIT)',
    async (caminho, teto) => {
      const cliente = await percorrer(caminho);
      const rotulos = cliente.idas.map((i) => i.rotulo);

      expect(rotulos[0]).toBe('BEGIN');
      expect(rotulos[rotulos.length - 1]).toBe('COMMIT');
      expect(cliente.idas.length).toBeLessThanOrEqual(teto);
    },
  );
});

describe('SPEC-082/AC-008 — as três transações leitoras declaram o tempo-limite', () => {
  it.each(['entrar', 'allocateStudent', 'confirmar'] as const)(
    '%s passa { timeout: 8000 } ao $transaction',
    async (caminho) => {
      const cliente = await percorrer(caminho);

      expect(cliente.opcoesDasTransacoes).toEqual([{ timeout: 8000 }]);
      expect(TIMEOUT_DA_MATRICULA_MS).toBe(8000);
    },
  );
});

describe('SPEC-082/AC-014 — o tempo-limite cabe por construção', () => {
  /**
   * A conta do D3: a espera TOTAL é de no máximo 2 s (AC-015), cada ida custa
   * no orçamento 250 ms (acima dos ~150–200 ms medidos em produção), e sobra
   * 1 s. Se um teto subir sem o timeout acompanhar, fica vermelho aqui.
   */
  function piorCaminhoMs(teto: number): number {
    return (
      PRAZO_DA_MATRICULA_MS +
      teto * LATENCIA_DE_ORCAMENTO_MS +
      FOLGA_DO_TIMEOUT_MS
    );
  }

  it('os parâmetros da conta são os do D3', () => {
    expect(PRAZO_DA_MATRICULA_MS).toBe(2000);
    expect(LATENCIA_DE_ORCAMENTO_MS).toBe(250);
    expect(FOLGA_DO_TIMEOUT_MS).toBe(1000);
  });

  it.each(Object.entries(TETOS) as [Caminho, number][])(
    '%s: 2000 + %i × 250 + 1000 ≤ timeout',
    (_caminho, teto) => {
      expect(piorCaminhoMs(teto)).toBeLessThanOrEqual(TIMEOUT_DA_MATRICULA_MS);
    },
  );

  it('o maior, confirmar, dá exatamente o timeout (8.000 ms)', () => {
    expect(piorCaminhoMs(TETOS.confirmar)).toBe(TIMEOUT_DA_MATRICULA_MS);
  });
});

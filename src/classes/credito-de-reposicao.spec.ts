/**
 * SPEC-064/TASK-002 — **as duas regras de crédito, lado a lado.**
 *
 * Estes casos existem por um motivo específico: trazer a regra de dois lugares
 * para um só **tornou visível uma divergência** que estava escondida por estar
 * escrita em duas funções diferentes do mesmo arquivo. O caso
 * `reposta em aula cancelada` é o que a documenta — e enquanto ele estiver
 * aqui, verde, ninguém "conserta" um dos dois lados por engano achando que são
 * a mesma conta.
 */
import {
  expiracaoDoCredito,
  situacaoDoCredito,
  type FaltaParaCredito,
} from './credito-de-reposicao';

const VALIDADE = 30;
const HOJE = new Date('2026-09-20T00:00:00.000Z');

const falta = (
  opcoes: Partial<{
    data: string;
    statusPagamento: string;
    reposicaoEm: string | null;
  }> = {},
): FaltaParaCredito => ({
  ocupacao: {
    data: new Date(`${opcoes.data ?? '2026-09-10'}T00:00:00.000Z`),
    statusPagamento: opcoes.statusPagamento ?? 'pendente_pagamento',
  },
  reposicao:
    opcoes.reposicaoEm === undefined
      ? null
      : opcoes.reposicaoEm === null
        ? null
        : { ocupacao: { statusPagamento: opcoes.reposicaoEm } },
});

describe('expiracaoDoCredito', () => {
  it('soma os dias em UTC', () => {
    // Em fuso local, somar 30 dias sobre uma data que o Prisma entrega à
    // meia-noite UTC deslocaria o limite em um dia para metade do país.
    expect(
      expiracaoDoCredito(new Date('2026-09-10T00:00:00.000Z'), 30)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-10-10');
  });
});

describe('situacaoDoCredito — o que as DUAS regras concordam', () => {
  it('falta comum dentro do prazo é crédito pelos dois critérios', () => {
    const s = situacaoDoCredito(falta(), VALIDADE, HOJE);
    expect(s.contaComoSaldo).toBe(true);
    expect(s.utilizavel).toBe(true);
  });

  it('falta expirada não vale por nenhum dos dois', () => {
    const s = situacaoDoCredito(falta({ data: '2026-08-01' }), VALIDADE, HOJE);
    expect(s.expirada).toBe(true);
    expect(s.contaComoSaldo).toBe(false);
    expect(s.utilizavel).toBe(false);
  });

  it('aula cancelada pelo clube não gera crédito: ele não perdeu nada', () => {
    const s = situacaoDoCredito(
      falta({ statusPagamento: 'cancelado' }),
      VALIDADE,
      HOJE,
    );
    expect(s.aulaCancelada).toBe(true);
    expect(s.contaComoSaldo).toBe(false);
    expect(s.utilizavel).toBe(false);
  });

  it('já reposta numa aula que vai acontecer não vale por nenhum dos dois', () => {
    const s = situacaoDoCredito(
      falta({ reposicaoEm: 'pendente_pagamento' }),
      VALIDADE,
      HOJE,
    );
    expect(s.reposta).toBe(true);
    expect(s.contaComoSaldo).toBe(false);
    expect(s.utilizavel).toBe(false);
  });
});

describe('situacaoDoCredito — o caso em que as duas DISCORDAM', () => {
  /**
   * **Este é o caso que justifica o arquivo inteiro, e virou o DEF-036.**
   *
   * SPEC-046/D7: *"reposição em aula cancelada não conta, e o crédito volta
   * sozinho"* — e ele voltava **só na tela**. A linha de `reposicoes_de_aula`
   * continuava existindo (só `desmarcar` apagava), a INV-118 é
   * `UNIQUE (falta_id)` e o `marcar` recusava com `FALTA_JA_REPOSTA`: **o saldo
   * mostrava um crédito que não podia ser gasto.**
   *
   * O DEF-036 fechou — cancelar a aula passou a apagar as reposições dela —,
   * então o sistema **não produz mais** este estado. Estes casos ficam porque a
   * função é pura e o estado continua **construtível à mão**: dado antigo, um
   * `INSERT` direto, uma migração. `utilizavel` é a única que prevê o que o
   * `marcar` vai fazer, e é ela que a fila usa.
   */
  it('reposta numa aula que o clube CANCELOU: conta no saldo, mas não é utilizável', () => {
    const s = situacaoDoCredito(
      falta({ reposicaoEm: 'cancelado' }),
      VALIDADE,
      HOJE,
    );
    expect(s.reposta).toBe(false);
    // O que `meuCredito` mostra na tela: o crédito voltou.
    expect(s.contaComoSaldo).toBe(true);
    // O que o `marcar` aceita: nada — `FALTA_JA_REPOSTA`.
    expect(s.utilizavel).toBe(false);
  });

  it('a fila de espera usa a regra ESTRITA, e é a única que evita convite falso', () => {
    // Se a fila usasse `contaComoSaldo`, esta pessoa entraria na fila, seria
    // chamada, correria até o clube e levaria 409 na confirmação.
    const s = situacaoDoCredito(
      falta({ reposicaoEm: 'cancelado' }),
      VALIDADE,
      HOJE,
    );
    expect(s.utilizavel).toBe(false);
  });
});

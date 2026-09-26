import {
  filtroDeTurmaPorNivel,
  mensagemDeNivelIncompativel,
  nivelEfetivoDoAluno,
  podeEntrarPorNivel,
  primeiroNivel,
  type LeitorDeNivel,
} from './nivel-efetivo';

/**
 * SPEC-075 — o núcleo da regra, testado direto. O que depende do banco (o
 * desempate de verdade, os cinco gestos, as listas) está em
 * `test/banco/spec-075-acesso.db-spec.ts`; aqui fica o que é puro.
 */

const INI = { id: 'n-ini', nome: 'Iniciante', doPrimeiro: false };
const AVA = { id: 'n-ava', nome: 'Avançado', doPrimeiro: false };

describe('podeEntrarPorNivel (D2)', () => {
  it('turma SEM nível aceita todos — com nível, sem nível, e empresa sem nível', () => {
    expect(podeEntrarPorNivel(null, INI)).toBe(true);
    expect(podeEntrarPorNivel(null, null)).toBe(true);
  });

  it('turma COM nível aceita só o nível EXATO', () => {
    expect(podeEntrarPorNivel('n-ini', INI)).toBe(true);
    expect(podeEntrarPorNivel('n-ava', INI)).toBe(false);
  });

  it('turma com nível e aluno sem nível efetivo → recusa (falha fechada)', () => {
    expect(podeEntrarPorNivel('n-ava', null)).toBe(false);
  });
});

describe('filtroDeTurmaPorNivel — o MESMO predicado, escrito para o `where`', () => {
  /**
   * A única segunda forma da regra. Esta prova a amarra à primeira: para cada
   * combinação, "a turma passa no `where`" é igual a `podeEntrarPorNivel`.
   * O `where` é avaliado aqui por um intérprete mínimo do que o filtro emite
   * (`{}` ou `{ OR: [{ nivelId }] }`) — se o filtro mudar de forma, o
   * intérprete lança, e a prova avisa em vez de passar calada.
   */
  function passa(where: Record<string, unknown>, nivelId: string | null) {
    const chaves = Object.keys(where);
    if (chaves.length === 0) return true;
    if (chaves.length !== 1 || chaves[0] !== 'OR') {
      throw new Error('forma nova de filtro: ' + JSON.stringify(where));
    }
    return (where.OR as { nivelId: string | null }[]).some(
      (c) => c.nivelId === nivelId,
    );
  }

  const turmas = [null, 'n-ini', 'n-ava'];
  const efetivos = [null, INI, AVA];
  for (const efetivo of efetivos) {
    for (const nivelDaTurma of turmas) {
      it(`efetivo=${efetivo?.id ?? 'nenhum'} turma=${nivelDaTurma ?? 'sem nível'}`, () => {
        // Empresa sem nível não tem turma com nível (FK composta da D9): o
        // caso "efetivo nenhum, turma com nível" não existe no banco, e o
        // filtro não corta nada ali — por isso fica de fora da comparação.
        if (efetivo === null && nivelDaTurma !== null) return;
        expect(passa(filtroDeTurmaPorNivel(efetivo), nivelDaTurma)).toBe(
          podeEntrarPorNivel(nivelDaTurma, efetivo),
        );
      });
    }
  }
});

describe('mensagemDeNivelIncompativel (D4, AC-017, AC-020) — o texto inteiro', () => {
  const INTER = { id: 'n-int', nome: 'Intermediário', doPrimeiro: false };
  const PRIMEIRO = { id: 'n-ini', nome: 'Iniciante', doPrimeiro: true };

  it('ao ALUNO com nível', () => {
    expect(mensagemDeNivelIncompativel('aluno', 'Avançado', INTER)).toBe(
      'Esta turma é do nível Avançado. O seu nível é Intermediário.',
    );
  });

  it('ao ALUNO sem nível — diz que ele conta como o primeiro', () => {
    expect(mensagemDeNivelIncompativel('aluno', 'Avançado', PRIMEIRO)).toBe(
      'Esta turma é do nível Avançado. O clube ainda não definiu o seu nível; por enquanto você conta como Iniciante.',
    );
  });

  it('ao GESTOR com nível — diz o que fazer', () => {
    expect(mensagemDeNivelIncompativel('gestor', 'Avançado', INTER)).toBe(
      'Esta turma é do nível Avançado, e este aluno é Intermediário. Para alocá-lo, mude o nível dele.',
    );
  });

  it('ao GESTOR sem nível — diz que conta como o primeiro, e o que fazer', () => {
    expect(mensagemDeNivelIncompativel('gestor', 'Avançado', PRIMEIRO)).toBe(
      'Esta turma é do nível Avançado, e este aluno ainda não tem nível — ele conta como Iniciante. Para alocá-lo, defina o nível dele.',
    );
  });

  it('o texto do gestor DIFERE do texto do aluno (AC-020)', () => {
    expect(mensagemDeNivelIncompativel('gestor', 'Avançado', INTER)).not.toBe(
      mensagemDeNivelIncompativel('aluno', 'Avançado', INTER),
    );
  });
});

describe('primeiroNivel e nivelEfetivoDoAluno (D1)', () => {
  function leitor(respostas: unknown[]) {
    const findFirst = jest.fn();
    for (const r of respostas) findFirst.mockResolvedValueOnce(r);
    return {
      db: { nivel: { findFirst } } as unknown as LeitorDeNivel,
      findFirst,
    };
  }

  it('o primeiro é pedido por ordem, depois created_at, depois id (INV-075c)', async () => {
    const { db, findFirst } = leitor([{ id: 'n-ini', nome: 'Iniciante' }]);
    await primeiroNivel(db, 'c1');
    const [args] = findFirst.mock.calls[0] as [{ orderBy: unknown }];
    expect(args.orderBy).toEqual([
      { ordem: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('aluno COM nível: o efetivo é o dele (AC-001)', async () => {
    const { db } = leitor([{ id: 'n-ava', nome: 'Avançado' }]);
    expect(await nivelEfetivoDoAluno(db, 'c1', 'n-ava')).toEqual({
      id: 'n-ava',
      nome: 'Avançado',
      doPrimeiro: false,
    });
  });

  it('aluno SEM nível: o efetivo é o primeiro da empresa', async () => {
    const { db } = leitor([{ id: 'n-ini', nome: 'Iniciante' }]);
    expect(await nivelEfetivoDoAluno(db, 'c1', null)).toEqual({
      id: 'n-ini',
      nome: 'Iniciante',
      doPrimeiro: true,
    });
  });

  it('empresa SEM nível: efetivo nenhum (AC-003)', async () => {
    const { db } = leitor([null]);
    expect(await nivelEfetivoDoAluno(db, 'c1', null)).toBeNull();
  });
});

import {
  calcularOcupacao,
  carregarConjuntos,
  type ConjuntosDaOcorrencia,
  type LeitorDeConjuntos,
} from './ocupacao-da-ocorrencia';

/**
 * SPEC-057/TASK-005/D17 — a ocupação de uma ocorrência é conta de CONJUNTOS.
 *
 * A fórmula antiga (`matriculados − faltas + reposições`, SPEC-046) é soma de
 * contagens, e duas situações reais a quebram: o ex-matriculado cuja falta
 * avisada ficou retida (subtrai quem já não está) e o matriculado que também
 * marcou reposição na própria ocorrência (conta duas vezes). Os cinco casos
 * abaixo são os que o veredito v4 mediu em banco; cada um derruba a fórmula
 * antiga num ponto diferente.
 */
function conjuntos(
  m: string[],
  f: string[],
  v: string[],
): ConjuntosDaOcorrencia {
  return {
    matriculados: new Set(m),
    faltas: new Set(f),
    visitantes: new Set(v),
  };
}

describe('calcularOcupacao (D17/INV-145)', () => {
  it('ex-matriculado com falta retida NÃO gera ocupação negativa nem vaga acima da capacidade', () => {
    const r = calcularOcupacao(2, conjuntos([], ['saiu'], []));

    expect(r).toEqual({
      capacidade: 2,
      matriculados: 0,
      faltasAvisadas: 0,
      reposicoesMarcadas: 0,
      reposicoesNaOcupacao: 0,
      ocupados: 0,
      vagasNaOcorrencia: 2,
      cheia: false,
    });
  });

  it('M∩V sem falta: o aluno ocupa UMA vaga', () => {
    const r = calcularOcupacao(2, conjuntos(['a'], [], ['a']));

    expect(r).toMatchObject({
      matriculados: 1,
      faltasAvisadas: 0,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 0,
      ocupados: 1,
      vagasNaOcorrencia: 1,
    });
  });

  it('M∩F∩V: ocupa uma vaga, como visitante', () => {
    const r = calcularOcupacao(2, conjuntos(['a'], ['a'], ['a']));

    expect(r).toMatchObject({
      matriculados: 1,
      faltasAvisadas: 1,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 1,
      ocupados: 1,
      vagasNaOcorrencia: 1,
    });
  });

  it('visitante externo soma nas duas contagens de reposição', () => {
    const r = calcularOcupacao(2, conjuntos(['a'], [], ['b']));

    expect(r).toMatchObject({
      matriculados: 1,
      faltasAvisadas: 0,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 1,
      ocupados: 2,
      vagasNaOcorrencia: 0,
      cheia: true,
    });
  });

  it('lotação excedida conserva `ocupados` real e só limita as vagas a zero', () => {
    const r = calcularOcupacao(2, conjuntos(['a', 'b'], [], ['c']));

    expect(r).toMatchObject({
      matriculados: 2,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 1,
      ocupados: 3,
      vagasNaOcorrencia: 0,
      cheia: true,
    });
  });

  it('a identidade publicada vale: ocupados = matriculados − faltasAvisadas + reposicoesNaOcupacao', () => {
    const casos: [number, ConjuntosDaOcorrencia][] = [
      [3, conjuntos(['a', 'b', 'c'], ['b', 'x'], ['b', 'd', 'a'])],
      [1, conjuntos([], ['x'], ['y', 'z'])],
      [4, conjuntos(['a', 'b'], ['a', 'b'], [])],
    ];
    for (const [cap, c] of casos) {
      const r = calcularOcupacao(cap, c);
      expect(r.ocupados).toBe(
        r.matriculados - r.faltasAvisadas + r.reposicoesNaOcupacao,
      );
      expect(r.ocupados).toBeGreaterThanOrEqual(0);
      expect(r.vagasNaOcorrencia).toBe(Math.max(0, cap - r.ocupados));
    }
  });
});

describe('carregarConjuntos (NFR-001)', () => {
  function leitor(dados: {
    matriculas?: { turmaId: string; alunoId: string }[];
    faltas?: { ocupacaoId: string; alunoId: string }[];
    reposicoes?: { ocupacaoId: string; alunoId: string }[];
  }) {
    return {
      turmaAluno: {
        findMany: jest.fn().mockResolvedValue(dados.matriculas ?? []),
      },
      faltaAvisada: {
        findMany: jest.fn().mockResolvedValue(dados.faltas ?? []),
      },
      reposicaoDeAula: {
        findMany: jest.fn().mockResolvedValue(dados.reposicoes ?? []),
      },
    };
  }

  function ocorrencias(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `oc${i}`,
      turmaId: `t${i % 5}`,
    }));
  }

  it.each([20, 200])(
    'com %i ocorrências: exatamente três consultas, uma por conjunto',
    async (n) => {
      const db = leitor({});

      await carregarConjuntos(
        db as unknown as LeitorDeConjuntos,
        'empresa',
        ocorrencias(n),
      );

      expect(db.turmaAluno.findMany).toHaveBeenCalledTimes(1);
      expect(db.faltaAvisada.findMany).toHaveBeenCalledTimes(1);
      expect(db.reposicaoDeAula.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it('sem ocorrência: nenhuma consulta', async () => {
    const db = leitor({});

    const r = await carregarConjuntos(
      db as unknown as LeitorDeConjuntos,
      'empresa',
      [],
    );

    expect(r.size).toBe(0);
    expect(db.turmaAluno.findMany).not.toHaveBeenCalled();
    expect(db.faltaAvisada.findMany).not.toHaveBeenCalled();
    expect(db.reposicaoDeAula.findMany).not.toHaveBeenCalled();
  });

  it('faltas e reposições são escopadas pela empresa e pelos ids; turmas deduplicadas', async () => {
    const db = leitor({});

    await carregarConjuntos(
      db as unknown as LeitorDeConjuntos,
      'empresa-x',
      ocorrencias(20),
    );

    const [matArgs] = db.turmaAluno.findMany.mock.calls[0] as [
      { where: { turmaId: { in: string[] } } },
    ];
    expect([...matArgs.where.turmaId.in].sort()).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
    ]);
    for (const chamada of [
      db.faltaAvisada.findMany.mock.calls[0],
      db.reposicaoDeAula.findMany.mock.calls[0],
    ] as [{ where: { companyId: string; ocupacaoId: { in: string[] } } }][]) {
      expect(chamada[0].where.companyId).toBe('empresa-x');
      expect(chamada[0].where.ocupacaoId.in).toHaveLength(20);
    }
  });

  it('distribui cada linha na sua ocorrência; a matrícula vale para toda ocorrência da turma', async () => {
    const db = leitor({
      matriculas: [
        { turmaId: 't0', alunoId: 'a' },
        { turmaId: 't1', alunoId: 'b' },
      ],
      faltas: [{ ocupacaoId: 'oc0', alunoId: 'a' }],
      reposicoes: [
        { ocupacaoId: 'oc5', alunoId: 'z' },
        { ocupacaoId: 'oc0', alunoId: 'a' },
      ],
    });

    const r = await carregarConjuntos(
      db as unknown as LeitorDeConjuntos,
      'empresa',
      ocorrencias(6),
    );

    // oc0 e oc5 são ambas da turma t0.
    expect([...(r.get('oc0')?.matriculados ?? [])]).toEqual(['a']);
    expect([...(r.get('oc5')?.matriculados ?? [])]).toEqual(['a']);
    expect([...(r.get('oc0')?.faltas ?? [])]).toEqual(['a']);
    expect([...(r.get('oc5')?.faltas ?? [])]).toEqual([]);
    expect([...(r.get('oc0')?.visitantes ?? [])]).toEqual(['a']);
    expect([...(r.get('oc5')?.visitantes ?? [])]).toEqual(['z']);
    expect([...(r.get('oc1')?.matriculados ?? [])]).toEqual(['b']);
  });
});

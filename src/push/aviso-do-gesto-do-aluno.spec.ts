import {
  montarAvisoDoGestoDoAluno,
  TITULOS_DO_GESTO_DO_ALUNO,
  type AcaoDoAluno,
} from './aviso-do-gesto-do-aluno';

/**
 * SPEC-078/REQ-001 — o montador dos avisos das ações do aluno, sem I/O.
 *
 * Os textos são os aprovados pelo Israel em preview (I9). Datas explícitas: a
 * função é pura, e nenhuma delas é comparada com o relógio.
 */
const TURMA = '11111111-1111-4111-8111-111111111111';
/** 2026-10-01 é uma quinta. `@db.Date` chega como meia-noite UTC. */
const AULA = {
  data: new Date('2026-10-01T00:00:00.000Z'),
  horaInicio: new Date('1970-01-01T19:00:00.000Z'),
  horaFim: new Date('1970-01-01T20:00:00.000Z'),
};

describe('SPEC-078 — montarAvisoDoGestoDoAluno', () => {
  it.each<[AcaoDoAluno, string, string]>([
    [
      'reposicao_marcada',
      'Reposições',
      'Uma reposição foi marcada para quinta (19h)',
    ],
    [
      'reposicao_desmarcada',
      'Reposições',
      'Uma reposição de quinta (19h) foi desmarcada',
    ],
    [
      'falta_avisada',
      'Faltas',
      'Um aluno avisou que vai faltar na aula de quinta (19h)',
    ],
    [
      'falta_retirada',
      'Faltas',
      'Um aluno retirou o aviso de falta da aula de quinta (19h)',
    ],
  ])(
    '%s: título, corpo, a turma no destino e o fim da aula como prazo',
    (acao, titulo, corpo) => {
      const aviso = montarAvisoDoGestoDoAluno(acao, {
        turmaId: TURMA,
        aula: AULA,
      });
      expect(aviso).toEqual({
        titulo,
        corpo,
        destinoUrl: `/turmas/${TURMA}`,
        // 20h no fuso do clube (UTC-3) = 23h UTC.
        expiraEm: new Date('2026-10-01T23:00:00.000Z'),
      });
    },
  );

  it.each<[AcaoDoAluno, string]>([
    ['entrou_na_turma', 'Um aluno entrou em uma das turmas'],
    ['saiu_da_turma', 'Um aluno saiu de uma das turmas'],
  ])('%s: título Turmas, sem aula e sem prazo', (acao, corpo) => {
    expect(
      montarAvisoDoGestoDoAluno(acao, { turmaId: TURMA, aula: null }),
    ).toEqual({
      titulo: 'Turmas',
      corpo,
      destinoUrl: `/turmas/${TURMA}`,
      expiraEm: null,
    });
  });

  it('meia hora sai como "19h30", e não "19:30" — a mesma regra dos avisos do gestor', () => {
    const aviso = montarAvisoDoGestoDoAluno('falta_avisada', {
      turmaId: TURMA,
      aula: { ...AULA, horaInicio: new Date('1970-01-01T19:30:00.000Z') },
    });
    expect(aviso.corpo).toBe(
      'Um aluno avisou que vai faltar na aula de quinta (19h30)',
    );
  });

  it.each<AcaoDoAluno>([
    'reposicao_marcada',
    'reposicao_desmarcada',
    'falta_avisada',
    'falta_retirada',
  ])('%s sem a aula é erro de programação, e não um aviso sem dia', (acao) => {
    expect(() =>
      montarAvisoDoGestoDoAluno(acao, { turmaId: TURMA, aula: null }),
    ).toThrow(/precisa da aula/);
  });

  it('os títulos saem só do vocabulário fechado', () => {
    const acoes: AcaoDoAluno[] = [
      'reposicao_marcada',
      'reposicao_desmarcada',
      'falta_avisada',
      'falta_retirada',
      'entrou_na_turma',
      'saiu_da_turma',
    ];
    for (const acao of acoes) {
      const aula =
        acao.startsWith('entrou') || acao.startsWith('saiu') ? null : AULA;
      const { titulo } = montarAvisoDoGestoDoAluno(acao, {
        turmaId: TURMA,
        aula,
      });
      expect(TITULOS_DO_GESTO_DO_ALUNO).toContain(titulo);
    }
  });
});

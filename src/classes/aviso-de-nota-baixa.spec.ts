import {
  entrouNaFaixaBaixa,
  montarAvisoDeNotaBaixa,
  NOTA_BAIXA_ATE,
  TITULO_DA_AVALIACAO,
} from './aviso-de-nota-baixa';

/**
 * SPEC-068/TASK-002 — **a regra da faixa, provada no nível em que ela existe.**
 *
 * ## Por que este arquivo precisou existir, e o que ele conserta
 *
 * A FIT-050 prova o **estado final** no banco. Sabotando a regra de entrada
 * para *"avisa sempre que a nota for baixa"*, a FIT continuou **verde** — e
 * estava certa em continuar: a UNIQUE parcial mais o `ON CONFLICT DO NOTHING`
 * absorvem a inserção repetida, então o estado final é o mesmo.
 *
 * Isto é o que a spec já dizia com todas as letras — *"a leitura do estado
 * anterior é economia de trabalho, não proteção"* —, mas só ficou **provado**
 * quando a sabotagem mostrou que a FIT não distinguia os dois casos.
 *
 * **E o inverso também era verdade:** com a regra funcionando, o
 * `ON CONFLICT` nunca chegava a ser exercitado, então sabotá-lo também ficava
 * verde. Os dois mecanismos se mascaravam. A FIT ganhou um caso que chama o
 * enfileirador **duas vezes** para exercitar a constraint sozinha; este
 * arquivo prova a regra sozinha.
 */
describe('SPEC-068 — a entrada na faixa baixa', () => {
  it('a faixa é 1 e 2, e o limiar está num lugar só', () => {
    expect(NOTA_BAIXA_ATE).toBe(2);
  });

  it.each([
    ['sem avaliação anterior, nota 1', null, 1, true],
    ['sem avaliação anterior, nota 2', null, 2, true],
    ['sem avaliação anterior, nota 3', null, 3, false],
    ['5 → 1: entra na faixa', 5, 1, true],
    ['3 → 2: entra na faixa', 3, 2, true],
    ['1 → 1: regravação, não é entrada', 1, 1, false],
    ['1 → 2: já estava na faixa', 1, 2, false],
    [
      '2 → 1: já estava na faixa — piora, mas é a mesma reclamação',
      2,
      1,
      false,
    ],
    ['2 → 5: saiu da faixa', 2, 5, false],
    ['4 → 5: nunca esteve', 4, 5, false],
  ])('%s', (_nome, anterior, nova, esperado) => {
    expect(entrouNaFaixaBaixa(anterior, nova)).toBe(esperado);
  });
});

describe('SPEC-068 — o texto do aviso', () => {
  const fatos = {
    nota: 1,
    turmaId: '11111111-1111-4111-8111-111111111111',
    data: new Date('2026-09-17T00:00:00Z'),
    horaInicio: new Date('1970-01-01T19:00:00Z'),
  };

  it('diz a nota, o dia e a hora — e nada mais', () => {
    const aviso = montarAvisoDeNotaBaixa(fatos);
    expect(aviso.titulo).toBe(TITULO_DA_AVALIACAO);
    expect(aviso.corpo).toContain('1 estrela');
    expect(aviso.corpo).toMatch(/\(\d{1,2}h(\d{2})?\)/);
  });

  it('duas estrelas no plural, uma no singular', () => {
    expect(montarAvisoDeNotaBaixa({ ...fatos, nota: 2 }).corpo).toContain(
      '2 estrelas',
    );
    expect(montarAvisoDeNotaBaixa(fatos).corpo).toContain('1 estrela');
    expect(montarAvisoDeNotaBaixa(fatos).corpo).not.toContain('1 estrelas');
  });

  it('a URL é da TURMA, e carrega id — nunca nome', () => {
    expect(montarAvisoDeNotaBaixa(fatos).destinoUrl).toBe(
      `/turmas/${fatos.turmaId}`,
    );
  });

  it('sem data, o corpo continua honesto em vez de inventar quando', () => {
    const semData = montarAvisoDeNotaBaixa({
      ...fatos,
      data: null,
      horaInicio: null,
    });
    expect(semData.corpo).toBe('Uma aula recebeu 1 estrela');
  });
});

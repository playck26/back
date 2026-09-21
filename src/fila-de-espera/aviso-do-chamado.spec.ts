/**
 * SPEC-064/D7 — o texto do chamado.
 *
 * **O que está em julgamento aqui é o que o aviso NÃO diz:** nome de turma
 * (INV-063a proíbe texto livre de tabela), slug na URL (AC-007 da SPEC-063), e
 * qualquer promessa de que a vaga está reservada (LIM-064a).
 */
import {
  montarAvisoDoChamado,
  TIPO_LISTA_ESPERA,
  TITULO_DO_CHAMADO,
} from './aviso-do-chamado';

/** 2026-09-24 é uma quinta. `DATE` chega à meia-noite UTC. */
const QUINTA = new Date('2026-09-24T00:00:00.000Z');
/** `TIME` chega em 1970-01-01. 19h no fuso do clube. */
const AS_19H = new Date('1970-01-01T19:00:00.000Z');
const AS_19H30 = new Date('1970-01-01T19:30:00.000Z');
/** Quarta, 18h em São Paulo = 21h UTC. */
const PRAZO = new Date('2026-09-23T21:00:00.000Z');

describe('o aviso do chamado', () => {
  it('o tipo fica FORA de `gesto` e de `teste` — e é isso que o põe na caixa', () => {
    // A caixa da SPEC-065 recorta por exclusão (`tipo <> 'teste'`), decisão
    // tomada pensando nesta spec: com allowlist, esquecer de acrescentar o
    // tipo significaria a pessoa não ver um aviso que recebeu.
    expect(TIPO_LISTA_ESPERA).toBe('lista_espera');
    expect(TIPO_LISTA_ESPERA).not.toBe('gesto');
    expect(TIPO_LISTA_ESPERA).not.toBe('teste');
  });

  it('o título é `Sua vez`, e não um dos três do vocabulário de gesto', () => {
    // AC-018 da SPEC-063 fecha o vocabulário de `tipo='gesto'` em `Reservas`,
    // `Sua aula` e `Sua turma`. O chamado não é gesto — e a separação é
    // deliberada: invariante que atropela o vizinho é invariante que alguém
    // desliga.
    expect(TITULO_DO_CHAMADO).toBe('Sua vez');
    expect(['Reservas', 'Sua aula', 'Sua turma']).not.toContain(
      TITULO_DO_CHAMADO,
    );
  });

  it('fila de AULA: diz o dia, a hora e o prazo — e nenhum nome de turma', () => {
    const aviso = montarAvisoDoChamado({
      fila: 'aula',
      turmaId: '5f7c1e2a-0000-4000-8000-000000000001',
      data: QUINTA,
      horaInicio: AS_19H,
      chamadoAte: PRAZO,
    });

    expect(aviso.corpo).toContain('quinta (19h)');
    expect(aviso.corpo).toContain('quarta às 18h');
    // LIM-064a — a fila NÃO reserva a vaga, e o texto tem de dizer isso.
    expect(aviso.corpo).toContain('quem marcar primeiro fica com ela');
  });

  it('19h30 vira `19h30`, e não `19:30`', () => {
    const aviso = montarAvisoDoChamado({
      fila: 'aula',
      turmaId: null,
      data: QUINTA,
      horaInicio: AS_19H30,
      chamadoAte: PRAZO,
    });
    expect(aviso.corpo).toContain('quinta (19h30)');
    expect(aviso.corpo).not.toContain('19:30');
  });

  it('`expira_em` é o prazo da vez — é do ENVIO, não da caixa', () => {
    const aviso = montarAvisoDoChamado({
      fila: 'aula',
      turmaId: null,
      data: QUINTA,
      horaInicio: AS_19H,
      chamadoAte: PRAZO,
    });
    // Passou a vez, não adianta mais tentar entregar o push. A linha continua
    // legível em `/avisos` — SPEC-065/D7 separa as duas coisas.
    expect(aviso.expiraEm).toEqual(PRAZO);
  });

  it('a URL carrega ID, nunca slug', () => {
    const turmaId = '5f7c1e2a-0000-4000-8000-000000000001';
    const daTurma = montarAvisoDoChamado({
      fila: 'turma',
      turmaId,
      data: null,
      horaInicio: null,
      chamadoAte: PRAZO,
    });
    expect(daTurma.destinoUrl).toBe(`/minhas-aulas/turma/${turmaId}`);

    // Não há rota de UMA ocorrência na visão do aluno: a aula vive na lista.
    const daAula = montarAvisoDoChamado({
      fila: 'aula',
      turmaId,
      data: QUINTA,
      horaInicio: AS_19H,
      chamadoAte: PRAZO,
    });
    expect(daAula.destinoUrl).toBe('/minhas-aulas');
  });

  it('fila de TURMA sem ocorrência conhecida ainda diz o prazo', () => {
    const aviso = montarAvisoDoChamado({
      fila: 'turma',
      turmaId: '5f7c1e2a-0000-4000-8000-000000000001',
      data: null,
      horaInicio: null,
      chamadoAte: PRAZO,
    });
    expect(aviso.corpo).toContain('quarta às 18h');
    expect(aviso.corpo).toContain('quem entrar primeiro fica com ela');
  });
});

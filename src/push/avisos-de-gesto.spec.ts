import type { TipoDeAcao } from '@prisma/client';
import { parseDateOnly, parseTimeOnly } from '../courts/date-time.util';
import {
  montarAviso,
  PUBLICO_POR_TIPO,
  TITULOS_DE_GESTO,
  type FatosDoGesto,
  type PapelDoDestinatario,
} from './avisos-de-gesto';

/**
 * SPEC-063 — **a D4 e a D5 provadas sem banco.**
 *
 * O que se prova aqui é o que a spec decidiu sobre TEXTO: título, corpo,
 * destino e prazo. Quem recebe é do enfileirador, e a matriz inteira em banco
 * real é da FIT-049.
 *
 * **Por que vale a pena estar separado:** três rodadas de validação
 * independente caíram sobre "a lista não está toda coberta". Aqui a lista é
 * percorrida por `Object.keys`, e não por leitura — acrescentar valor ao enum
 * sem decidir o texto quebra este arquivo, e não a produção.
 */

const TODOS = Object.keys(PUBLICO_POR_TIPO) as TipoDeAcao[];

const QUE_AVISAM = TODOS.filter((t) => PUBLICO_POR_TIPO[t] !== 'ninguem');

const DINHEIRO: TipoDeAcao[] = [
  'pagamento_confirmado',
  'credito_lancado',
  'credito_retirado',
];

const PAPEIS: PapelDoDestinatario[] = ['gestor', 'aluno', 'professor'];

/** Quinta-feira, 19h às 20h. */
function fatos(parcial: Partial<FatosDoGesto> = {}): FatosDoGesto {
  return {
    quantidade: 1,
    turmaId: 'aaaaaaaa-0000-4000-8000-000000000001',
    data: parseDateOnly('2026-09-24'),
    horaInicio: parseTimeOnly('19:00'),
    horaFim: parseTimeOnly('20:00'),
    ...parcial,
  };
}

describe('SPEC-063 — a matriz dos treze tipos', () => {
  it('tem exatamente treze tipos, e todos decidiram público', () => {
    expect(TODOS).toHaveLength(13);
    expect(TODOS.every((t) => PUBLICO_POR_TIPO[t] !== undefined)).toBe(true);
  });

  /**
   * **AC-016 — provar o zero é tão importante quanto provar o um.** Sem este
   * caso, alguém acrescenta um aviso de pagamento por parecer útil, e ninguém
   * lembra que isso foi decidido fora do escopo do card (LIM-063b).
   */
  it.each(DINHEIRO)('%s não gera aviso nenhum (AC-016)', (tipo) => {
    for (const papel of PAPEIS) {
      expect(montarAviso(tipo, papel, fatos())).toBeNull();
    }
  });

  it('os três tipos de dinheiro são os ÚNICOS que não avisam', () => {
    expect(
      TODOS.filter((t) => PUBLICO_POR_TIPO[t] === 'ninguem').sort(),
    ).toEqual([...DINHEIRO].sort());
  });
});

describe('SPEC-063/AC-018 — o vocabulário fechado de títulos', () => {
  it.each(QUE_AVISAM)('%s usa título do vocabulário', (tipo) => {
    for (const papel of PAPEIS) {
      const aviso = montarAviso(tipo, papel, fatos());
      expect(aviso).not.toBeNull();
      expect(TITULOS_DE_GESTO).toContain(aviso!.titulo);
    }
  });

  /**
   * O quarto valor, `"Avisos do clube"`, é do aviso de teste da SPEC-062 e
   * **não pertence a esta spec**. Invariante que atropela o vizinho é
   * invariante que alguém desliga (ressalva N01 da 4ª rodada).
   */
  it('o vocabulário tem três valores, e não inclui o do aviso de teste', () => {
    expect([...TITULOS_DE_GESTO]).toEqual([
      'Reservas',
      'Sua aula',
      'Sua turma',
    ]);
    expect(TITULOS_DE_GESTO).not.toContain('Avisos do clube');
  });
});

describe('SPEC-063/AC-007 — nenhum campo carrega texto livre', () => {
  /**
   * A prova varre os **três** campos: `titulo`, `corpo` E `destino_url`.
   *
   * Tirar o nome do corpo e deixá-lo na URL seria mudar o vazamento de lugar
   * (achado R05 da 2ª rodada) — por isso a URL carrega id, nunca slug.
   */
  const TEXTO_LIVRE = [
    'Turma da Ana', // Turma.nome — o clube escolhe, e este nome é plausível
    'Ana Paula', // Usuario.nome
    'Quadra Central', // Quadra.nome
    '11988887777', // telefone
    'ana@exemplo.com', // e-mail
    '180,00', // valor
  ];

  it.each(QUE_AVISAM)('%s não vaza nada dos três campos', (tipo) => {
    for (const papel of PAPEIS) {
      const aviso = montarAviso(tipo, papel, fatos())!;
      const tudo = `${aviso.titulo} ${aviso.corpo} ${aviso.destinoUrl}`;
      for (const proibido of TEXTO_LIVRE) {
        expect(tudo).not.toContain(proibido);
      }
    }
  });

  it.each(QUE_AVISAM)('%s: a URL carrega id, nunca slug (AC-007)', (tipo) => {
    for (const papel of PAPEIS) {
      const { destinoUrl } = montarAviso(tipo, papel, fatos())!;
      expect(destinoUrl.startsWith('/')).toBe(true);
      // Cada segmento é rota conhecida ou um uuid. Nada de texto do clube.
      for (const seg of destinoUrl.split('/').filter(Boolean)) {
        const ehUuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            seg,
          );
        const ehRota = /^[a-z-]+$/.test(seg);
        expect(ehUuid || ehRota).toBe(true);
      }
    }
  });
});

describe('SPEC-063/AC-009 — o prazo é o FIM da ocorrência, ou nada', () => {
  const FIM_DA_QUINTA = Date.UTC(2026, 8, 24, 23, 0); // 20h em -03

  it.each([
    'aula_cancelada',
    'aula_reativada',
    'reserva_cancelada',
    'reserva_movida',
  ] as TipoDeAcao[])('%s expira no fim da ocorrência', (tipo) => {
    const { expiraEm } = montarAviso(tipo, 'aluno', fatos())!;
    expect(expiraEm).not.toBeNull();
    expect(expiraEm!.getTime()).toBe(FIM_DA_QUINTA);
  });

  /**
   * **Resumo não tem instante** (achado 02): ele cobre N ocorrências, e
   * escolher uma delas descartaria o resto em silêncio.
   */
  it.each([
    'turma_horario_editado',
    'turma_inativada',
    'turma_criada',
    'turma_reativada',
    'turma_aluno_removido',
    'reserva_criada',
  ] as TipoDeAcao[])('%s não tem prazo (AC-002, AC-009, AC-014)', (tipo) => {
    expect(montarAviso(tipo, 'aluno', fatos())!.expiraEm).toBeNull();
  });

  /**
   * **AC-012, a razão de o prazo ser o fim e não o início.** A v2 expirava no
   * começo da aula, e o efeito era o oposto do pretendido: o tick roda a cada
   * 60 s, então um cancelamento feito dois minutos antes podia ser varrido
   * como `expirada` sem uma única tentativa de envio — e o cancelamento de
   * última hora é o mais valioso de todos.
   */
  it('cancelamento dois minutos antes ainda tem a aula inteira de prazo', () => {
    const { expiraEm } = montarAviso('aula_cancelada', 'aluno', fatos())!;
    const doisMinutosAntes = Date.UTC(2026, 8, 24, 21, 58); // 18h58 em -03
    expect(expiraEm!.getTime()).toBeGreaterThan(doisMinutosAntes);
    // E a folga é a duração da aula, não um punhado de segundos.
    expect(expiraEm!.getTime() - doisMinutosAntes).toBeGreaterThan(60 * 60_000);
  });

  it('sem ocorrência conhecida, não inventa prazo', () => {
    const semInstante = fatos({ data: null, horaInicio: null, horaFim: null });
    expect(
      montarAviso('aula_cancelada', 'aluno', semInstante)!.expiraEm,
    ).toBeNull();
  });
});

describe('SPEC-063/D4 — o corpo de cada fato', () => {
  it('reserva de 3 blocos diz 3 (AC-003, AC-017)', () => {
    const aviso = montarAviso(
      'reserva_criada',
      'gestor',
      fatos({ quantidade: 3, turmaId: null }),
    )!;
    expect(aviso.titulo).toBe('Reservas');
    expect(aviso.corpo).toBe('Nova reserva · 3 horários');
  });

  it('um bloco fala no singular', () => {
    const aviso = montarAviso(
      'reserva_criada',
      'gestor',
      fatos({ quantidade: 1, turmaId: null }),
    )!;
    expect(aviso.corpo).toBe('Nova reserva · 1 horário');
  });

  it('a aula cancelada diz o dia e a hora, sem "-feira"', () => {
    const aviso = montarAviso('aula_cancelada', 'aluno', fatos())!;
    expect(aviso.corpo).toBe('Sua aula de quinta (19h) foi cancelada');
  });

  it('meia hora quebrada aparece como 19h30', () => {
    const aviso = montarAviso(
      'aula_cancelada',
      'aluno',
      fatos({ horaInicio: parseTimeOnly('19:30') }),
    )!;
    expect(aviso.corpo).toBe('Sua aula de quinta (19h30) foi cancelada');
  });

  it('a aula reativada volta, e o resumo de grade não tem instante', () => {
    expect(montarAviso('aula_reativada', 'aluno', fatos())!.corpo).toBe(
      'Sua aula de quinta (19h) voltou',
    );
    expect(montarAviso('turma_horario_editado', 'aluno', fatos())!.corpo).toBe(
      'A grade de uma das suas turmas mudou',
    );
  });

  it.each([
    ['turma_inativada', 'Uma das suas turmas foi encerrada'],
    ['turma_criada', 'Você tem uma turma nova'],
    ['turma_reativada', 'Uma das suas turmas voltou'],
    ['turma_aluno_removido', 'Você saiu de uma turma'],
    ['reserva_movida', 'Uma reserva mudou de horário'],
  ] as [TipoDeAcao, string][])('%s diz "%s"', (tipo, esperado) => {
    expect(montarAviso(tipo, 'aluno', fatos())!.corpo).toBe(esperado);
  });
});

describe('SPEC-063/D6 — a rota depende do papel, porque os apps são outros', () => {
  it('o gestor vai para a agenda do Admin', () => {
    expect(
      montarAviso('reserva_criada', 'gestor', fatos({ turmaId: null }))!
        .destinoUrl,
    ).toBe('/agenda');
  });

  it('aluno e professor NÃO vão para a mesma tela da turma', () => {
    const doAluno = montarAviso('turma_horario_editado', 'aluno', fatos())!;
    const doProfessor = montarAviso(
      'turma_horario_editado',
      'professor',
      fatos(),
    )!;
    expect(doAluno.destinoUrl).toBe(
      '/minhas-aulas/turma/aaaaaaaa-0000-4000-8000-000000000001',
    );
    expect(doProfessor.destinoUrl).toBe(
      '/minhas-turmas/aaaaaaaa-0000-4000-8000-000000000001',
    );
  });

  /**
   * Quem saiu da turma não pertence mais a ela: mandá-lo para a tela da turma
   * seria mandá-lo para um 403.
   */
  it('o aluno removido vai para a lista, não para a turma de onde saiu', () => {
    expect(
      montarAviso('turma_aluno_removido', 'aluno', fatos())!.destinoUrl,
    ).toBe('/minhas-aulas/turmas');
  });

  it('sem turma conhecida, cai na lista em vez de montar URL quebrada', () => {
    expect(
      montarAviso('turma_horario_editado', 'aluno', fatos({ turmaId: null }))!
        .destinoUrl,
    ).toBe('/minhas-aulas');
    expect(
      montarAviso(
        'turma_horario_editado',
        'professor',
        fatos({ turmaId: null }),
      )!.destinoUrl,
    ).toBe('/minhas-turmas');
  });
});

import {
  chamadaJaRegistrada,
  chamadaPendente,
  resolverEstadoDaChamada,
  type EstadoDaChamada,
} from './estado-da-chamada';

// TEST (SPEC-030:TASK-005) — o resolvedor único do estado da chamada.
//
// **Por que este arquivo é curto e mesmo assim é o mais importante da
// spec:** a função aqui é pura e não precisa de banco nem de mock, mas é
// dela que dependem os quatro consumidores (INV-030b). Se ela mentir, o
// calendário, a lista da turma, o histórico do gestor e o relatório de
// frequência mentem juntos — e da mesma forma, o que torna a mentira
// invisível quando alguém compara duas telas.
//
// **Todo teste daqui fixa `agora`.** A lição de 2026-08-30 custou duas
// quedas de CI: a conta a fazer não é "isto está certo?", é "isto muda de
// resposta dependendo de quando roda?".

/** 2026-08-20, uma quinta-feira. Data fixa: nada aqui depende de hoje. */
const DIA = new Date(Date.UTC(2026, 7, 20));
const AS_18H = new Date(Date.UTC(1970, 0, 1, 18, 0));
const AS_19H = new Date(Date.UTC(1970, 0, 1, 19, 0));

function ocorrencia(
  over: Partial<Parameters<typeof resolverEstadoDaChamada>[0]> = {},
) {
  return {
    cancelada: false,
    completude: null,
    data: DIA,
    horaInicio: AS_18H,
    horaFim: AS_19H,
    ...over,
  };
}

/** Um instante do dia da aula, no fuso do clube (UTC-3). */
function as(hora: number, minuto = 0) {
  return new Date(Date.UTC(2026, 7, 20, hora + 3, minuto));
}

describe('SPEC-030 — o estado da chamada tem um dono só (INV-030b)', () => {
  describe('o cabeçalho manda sobre o relógio', () => {
    // Esta é a regra que substituiu `_count.presencas > 0`, e o caso abaixo
    // é exatamente o que a divergência antiga errava.
    it('cabeçalho `completa` é `feita` mesmo com a aula recém-terminada', () => {
      expect(
        resolverEstadoDaChamada(
          ocorrencia({ completude: 'completa' }),
          as(19, 1),
        ),
      ).toBe('feita');
    });

    it('cabeçalho `desconhecida` é `legada`, não `pendente`', () => {
      expect(
        resolverEstadoDaChamada(
          ocorrencia({ completude: 'desconhecida' }),
          as(23),
        ),
      ).toBe('legada');
    });

    it('cabeçalho `nao_houve` é `nao_houve`', () => {
      expect(
        resolverEstadoDaChamada(
          ocorrencia({ completude: 'nao_houve' }),
          as(23),
        ),
      ).toBe('nao_houve');
    });

    // **O caso que a validação cruzada da SPEC-027 procurou e não achou.**
    // Uma ocorrência com cabeçalho e ZERO presenças saía `feita` pelo
    // calendário e `pendente` pela lista da turma. Aqui ela tem UMA resposta.
    it('cabeçalho sem nenhuma presença ainda é `feita` — a turma inteira faltou', () => {
      expect(
        resolverEstadoDaChamada(ocorrencia({ completude: 'completa' }), as(20)),
      ).toBe('feita');
    });
  });

  describe('sem cabeçalho, os três momentos da SPEC-027', () => {
    it('antes do início: `futura`', () => {
      expect(resolverEstadoDaChamada(ocorrencia(), as(17, 59))).toBe('futura');
    });

    it('entre início e fim: `em_andamento`, e isso NÃO é pendência', () => {
      const estado = resolverEstadoDaChamada(ocorrencia(), as(18, 30));
      expect(estado).toBe('em_andamento');
      expect(chamadaPendente(estado)).toBe(false);
    });

    it('depois do fim: `pendente` — o vermelho do calendário', () => {
      expect(resolverEstadoDaChamada(ocorrencia(), as(19, 1))).toBe('pendente');
    });
  });

  describe('cancelada vem antes de tudo', () => {
    it('cancelada sem cabeçalho é `cancelada`, não `pendente`', () => {
      expect(
        resolverEstadoDaChamada(ocorrencia({ cancelada: true }), as(23)),
      ).toBe('cancelada');
    });

    // A precedência é decisão, e é ela que obriga o relatório de frequência a
    // NÃO usar o estado colapsado: a AC-005 precisa distinguir "cancelada com
    // chamada" de "cancelada sem chamada", e aqui as duas são `cancelada`.
    it('cancelada COM cabeçalho também é `cancelada` — a informação se perde de propósito', () => {
      expect(
        resolverEstadoDaChamada(
          ocorrencia({ cancelada: true, completude: 'completa' }),
          as(23),
        ),
      ).toBe('cancelada');
    });
  });

  describe('as duas perguntas derivadas', () => {
    const registrados: EstadoDaChamada[] = ['feita', 'legada', 'nao_houve'];
    const naoRegistrados: EstadoDaChamada[] = [
      'futura',
      'em_andamento',
      'pendente',
      'cancelada',
    ];

    it.each(registrados)('`%s` conta como chamada registrada', (estado) => {
      expect(chamadaJaRegistrada(estado)).toBe(true);
    });

    it.each(naoRegistrados)('`%s` não conta como registrada', (estado) => {
      expect(chamadaJaRegistrada(estado)).toBe(false);
    });

    // **O ponto da SPEC-030 inteira, em uma linha.** Antes, uma aula que não
    // aconteceu ficava `pendente` para sempre porque não havia como declarar
    // nada sobre ela.
    it('só `pendente` cobra ação — `nao_houve` apaga o vermelho', () => {
      expect(chamadaPendente('pendente')).toBe(true);
      expect(chamadaPendente('nao_houve')).toBe(false);
    });
  });

  // SABOTAGEM A (prova 13 da spec) — esta descrição existe para quem for
  // mexer no resolvedor: se você trocar a regra e SÓ este arquivo cair, a
  // unificação regrediu e algum consumidor voltou a ter regra própria. Os
  // quatro têm prova que passa por aqui:
  //   - agenda-do-professor.service.spec.ts  (calendário)
  //   - presenca.service.spec.ts             (lista da turma e histórico)
  //   - frequencia.service.spec.ts           (relatório)
  it('documenta a sabotagem A', () => {
    expect(resolverEstadoDaChamada(ocorrencia(), as(19, 1))).toBe('pendente');
  });
});

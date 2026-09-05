import {
  avaliarSaidaDeTurma,
  podeCancelar,
  type Antecedencia,
  type PrazoDeCancelamento,
} from './prazo-de-cancelamento';

/**
 * TEST-031/TASK-001 — a política de prazo, isolada.
 *
 * Cada caso aqui corresponde a um AC, e vários existem porque uma versão da
 * spec os contradizia: a v2 dizia ao mesmo tempo que o gestor cancela "a
 * qualquer momento" (AC-013) e que ninguém cancela depois do início
 * (AC-010b). A tabela abaixo é onde as duas afirmações passam a caber juntas.
 */

const SEM_PRAZO: PrazoDeCancelamento = { regra: 'SEM_PRAZO' };
const DUAS_HORAS: PrazoDeCancelamento = { regra: 'HORAS', horas: 2 };
const SEM_OCORRENCIA: Antecedencia = { tipo: 'SEM_OCORRENCIA' };
const minutos = (m: number): Antecedencia => ({ tipo: 'MINUTOS', minutos: m });

/** A política não lê relógio; este valor existe só para satisfazer o contrato. */
const AGORA = new Date('2026-09-05T12:00:00.000Z');

describe('podeCancelar (SPEC-031/REQ-003)', () => {
  it('AC-009: EXATAMENTE no limite, permite', () => {
    // Prazo 2h, aula 19h00, agora 17h00 → 120 minutos, e 120 >= 120.
    expect(podeCancelar(DUAS_HORAS, minutos(120))).toBe(true);
  });

  it('AC-009 (borda de baixo): um minuto a menos recusa', () => {
    expect(podeCancelar(DUAS_HORAS, minutos(119))).toBe(false);
  });

  it('AC-010: SEM_OCORRENCIA permite, mesmo com prazo configurado', () => {
    expect(podeCancelar(DUAS_HORAS, SEM_OCORRENCIA)).toBe(true);
  });

  /**
   * D5b — e este é o caso que a v2 não tinha. `SEM_PRAZO` significa "sem
   * antecedência mínima", **não** "sem limite".
   */
  it('AC-010b: aula ja iniciada recusa, INCLUSIVE sem prazo configurado', () => {
    expect(podeCancelar(SEM_PRAZO, minutos(0))).toBe(false);
    expect(podeCancelar(SEM_PRAZO, minutos(-5))).toBe(false);
    expect(podeCancelar(DUAS_HORAS, minutos(-5))).toBe(false);
  });

  it('sem prazo configurado e com a aula a frente, permite', () => {
    expect(podeCancelar(SEM_PRAZO, minutos(1))).toBe(true);
  });
});

describe('avaliarSaidaDeTurma (SPEC-031/D12, INV-066)', () => {
  const avaliar = (
    papelDoAutor: 'aluno' | 'company_admin',
    prazo: PrazoDeCancelamento,
    ocorrenciaRelevante: Antecedencia,
  ) =>
    avaliarSaidaDeTurma({
      papelDoAutor,
      agora: AGORA,
      prazo,
      ocorrenciaRelevante,
    });

  it('AC-006: aluno dentro do prazo e recusado com PRAZO_DE_CANCELAMENTO', () => {
    expect(avaliar('aluno', DUAS_HORAS, minutos(30))).toEqual({
      permitido: false,
      code: 'PRAZO_DE_CANCELAMENTO',
    });
  });

  it('aluno fora do prazo e aceito', () => {
    expect(avaliar('aluno', DUAS_HORAS, minutos(180))).toEqual({
      permitido: true,
    });
  });

  /**
   * AC-013 — o gestor ignora a antecedência mínima, **inclusive faltando
   * cinco minutos**.
   */
  it('AC-013: gestor ignora a antecedencia minima', () => {
    expect(avaliar('company_admin', DUAS_HORAS, minutos(5))).toEqual({
      permitido: true,
    });
  });

  /**
   * AC-013b — **e não ignora o início da aula.** É o AC que a v2 não tinha, e
   * por isso o bloqueante 1 existiu.
   */
  it('AC-013b: gestor com a aula EM ANDAMENTO e recusado', () => {
    expect(avaliar('company_admin', DUAS_HORAS, minutos(-1))).toEqual({
      permitido: false,
      code: 'PRAZO_DE_CANCELAMENTO',
    });
    expect(avaliar('company_admin', SEM_PRAZO, minutos(0))).toEqual({
      permitido: false,
      code: 'PRAZO_DE_CANCELAMENTO',
    });
  });

  it('AC-013b (o outro lado): dez minutos ANTES do inicio, o gestor passa', () => {
    expect(avaliar('company_admin', DUAS_HORAS, minutos(10))).toEqual({
      permitido: true,
    });
  });

  it('AC-010: sem ocorrencia futura, os dois papeis saem', () => {
    expect(avaliar('aluno', DUAS_HORAS, SEM_OCORRENCIA)).toEqual({
      permitido: true,
    });
    expect(avaliar('company_admin', DUAS_HORAS, SEM_OCORRENCIA)).toEqual({
      permitido: true,
    });
  });

  /**
   * INV-066, pelo comportamento e não pela leitura: o gestor **herda** a
   * recusa de `minutos <= 0` e **não herda** o prazo do clube. Se alguém
   * trocar o `SEM_PRAZO` por um `return { permitido: true }` antecipado, a
   * primeira linha continua passando e a segunda quebra.
   */
  it('INV-066: o gestor herda o corte do inicio, nao o prazo do clube', () => {
    expect(avaliar('company_admin', DUAS_HORAS, minutos(1)).permitido).toBe(
      true,
    );
    expect(avaliar('company_admin', DUAS_HORAS, minutos(0)).permitido).toBe(
      false,
    );
  });
});

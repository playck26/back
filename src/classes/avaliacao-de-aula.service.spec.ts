import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';

/**
 * SPEC-025 — as réguas da avaliação de aula, num lugar só.
 *
 * Este arquivo provava também a **INV-025a** sobre a média da turma que o aluno
 * lia. A SPEC-057/TASK-002/D12 tirou essa média do aluno e removeu a rota e o
 * método: a INV-025a passou a não ter onde valer, e as provas dela saíram
 * junto. Quem lê nota agora é só o gestor, pela lista com autoria
 * (`listarParaOGestor`), e o comportamento dela é provado no `fit-012`, contra
 * Postgres real.
 */

describe('as réguas ficam num lugar só', () => {
  it('detrator é quem deu 1 ou 2 — decisão sinalizada ao Israel', () => {
    // Escala 1–5 na leitura clássica: 1–2 detrator, 3 neutro, 4–5 promotor.
    // É a régua mais provável de ele querer mexer, e mora numa constante.
    expect(AvaliacaoDeAulaService.NOTA_MAXIMA_DE_DETRATOR).toBe(2);
  });

  it('o histórico de aulas anteriores olha 90 dias para trás', () => {
    expect(AvaliacaoDeAulaService.DIAS_DE_HISTORICO).toBe(90);
  });
});

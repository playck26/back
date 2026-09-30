import { Logger } from '@nestjs/common';

/**
 * SPEC-081/AC-017 — **o cenário de referência dos relatórios de frequência.**
 *
 * Um clube com 200 turmas × 3 encontros/semana × 90 dias ≈ 7.800
 * ocorrências. É até onde a contagem por ocorrência foi MEDIDA (AC-016); o
 * número de turmas continua sem teto no produto (LIM-081e). Acima dele, o
 * relatório segue respondendo, e o Back avisa — para o Israel saber antes de
 * alguém sentir.
 */
export const LIMIAR_DE_REFERENCIA = 7_800;

export type RotaDeFrequencia = 'daTurma' | 'doAluno' | 'evasao';

type LoggerDoAviso = Pick<Logger, 'warn'>;

export class AvisoDeReferencia {
  constructor(
    private readonly limiar: number = LIMIAR_DE_REFERENCIA,
    private readonly logger: LoggerDoAviso = new Logger('FrequenciaService'),
  ) {}

  /**
   * Uma vez por chamada do relatório. Sem dado pessoal: a rota, o número e
   * o clube — nenhum nome, nenhum id de aluno.
   */
  verificar(rota: RotaDeFrequencia, ocorrencias: number, companyId: string) {
    if (ocorrencias > this.limiar) {
      this.logger.warn({
        evento: 'relatorio_acima_da_referencia',
        rota,
        ocorrencias,
        companyId,
      });
    }
  }
}

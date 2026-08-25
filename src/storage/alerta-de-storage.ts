import { Injectable, Logger } from '@nestjs/common';

/**
 * SPEC-017/TASK-005 — os alertas de operação do MOD-008.
 *
 * **Cada código aqui existe porque um silêncio custa caro.** A fila é o
 * único mecanismo do produto que apaga arquivo sozinho; quando ela não faz o
 * que devia, o defeito não aparece em tela nenhuma — aparece meses depois,
 * como imagem quebrada ou como arquivo que devia ter sumido e não sumiu.
 *
 * O runbook de cada código é da TASK-007, em `OPERATIONS.md`. O que fica
 * aqui é o código estável e a razão de ele existir.
 */
export const ALERTAS = {
  /**
   * AC-014c — fila com item e **nenhum checker registrado**. Ausência com
   * fila vazia é o estado esperado no vão entre a 017 e a 018 e **não faz
   * barulho**; com item na fila, é anomalia.
   */
  SEM_CHECKER_COM_FILA: 'SEM_CHECKER_COM_FILA',
  /**
   * AC-014c — havia um checker registrado neste processo e ele sumiu. É o
   * caso que o fail-closed disfarça de normalidade.
   */
  CHECKER_SUMIU: 'CHECKER_SUMIU',
  /**
   * AC-016c/INV-047 — teto do ciclo estourado. O worker **não apaga nada**
   * nesta rodada. Exclusão em massa não é operação normal deste produto:
   * quando acontece, ou merece confirmação humana, ou é bug.
   */
  TETO_ESTOURADO: 'TETO_ESTOURADO',
  /** AC-016 — item com 5 tentativas falhas. Não some em silêncio. */
  EXCLUSAO_FALHANDO: 'EXCLUSAO_FALHANDO',
  /**
   * NFR-004/TASK-006 — o bucket passou de 50 GB, **ou a varredura não
   * conseguiu medir tudo**. Os dois levam à mesma conclusão: alguém precisa
   * olhar antes que a cota da conta — dividida com o `opinii-media`, porque
   * a assinatura do Spaces é por conta e não por bucket (ADR-015) — vire
   * problema de um produto que não tem nada a ver com isto.
   */
  BUCKET_GRANDE: 'BUCKET_GRANDE',
  /**
   * AC-016d — chave quente: reagendada por lock 20 vezes, ou 24 h em fila.
   * **Não é erro** — concorrência normal não é erro. Mas concorrência eterna
   * é estado degradado.
   */
  CHAVE_PRESA_EM_LOCK: 'CHAVE_PRESA_EM_LOCK',
} as const;

export type CodigoDeAlerta = (typeof ALERTAS)[keyof typeof ALERTAS];

export interface DetalheDoAlerta {
  readonly [campo: string]: string | number | boolean | null;
}

/**
 * Porta do alerta. Existe como porta e não como `Logger` direto porque o
 * teste precisa **provar que o alerta disparou** — e provar isso lendo log
 * seria testar a formatação, não o comportamento.
 */
export abstract class AlertaDeStorage {
  abstract disparar(codigo: CodigoDeAlerta, detalhe?: DetalheDoAlerta): void;
}

@Injectable()
export class AlertaPorLog extends AlertaDeStorage {
  private readonly logger = new Logger('StorageAlerta');

  disparar(codigo: CodigoDeAlerta, detalhe: DetalheDoAlerta = {}): void {
    // `error` e não `warn`: todo código desta lista pede ação humana. Alerta
    // que não acorda ninguém é log.
    this.logger.error({ alerta: codigo, ...detalhe });
  }
}

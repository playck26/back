import { Injectable, Logger } from '@nestjs/common';

/**
 * SPEC-017/TASK-005 — a costura que o corte em duas specs deixou no
 * improviso, e **é API pública do MOD-008**, não detalhe interno.
 *
 * O problema: a AC-014 manda o worker reconferir se a chave "voltou a ser
 * referenciada" — mas referenciada **por quê**? Pelas colunas de mídia, que
 * são todas da SPEC-018. A fundação precisava saber quem aponta, e quem
 * aponta só existe na spec seguinte.
 *
 * A saída: **porta aqui, implementação lá.** A 017 nunca conhece nome de
 * tabela da 018 — seria o vazamento na direção errada.
 */
export interface KeyReferenceChecker {
  /** "alguma linha ainda aponta para esta chave?" */
  estaReferenciada(key: string): Promise<boolean>;
}

export const RESULTADO_SEM_CHECKER = true;

/**
 * O registro. Guarda o checker que a SPEC-018 vai registrar, e — o que
 * importa mais — **decide o que responder quando não há nenhum**.
 *
 * **INV-044, fail-closed:** sem checker, tudo é tratado como referenciado e
 * o worker não apaga nada. Uma fundação no ar antes do consumidor **não pode
 * apagar por não saber quem aponta**: o silêncio tem de significar "não
 * sei", nunca "pode apagar".
 *
 * **E o fail-closed é a correção que cria o próximo problema**, apontado na
 * 5ª rodada de validação: depois que a SPEC-018 existir, um checker que
 * quebre ou seja desregistrado produz **exatamente o mesmo comportamento**
 * de quando ele nunca existiu — worker quieto, nada apagado. O defeito se
 * disfarça de estado normal, e demora muito mais para aparecer que o defeito
 * oposto.
 *
 * Por isso o registro lembra se **já teve** um checker (`jaTeveChecker`): é
 * o que permite distinguir "ainda não chegou" de "sumiu".
 */
@Injectable()
export class KeyReferenceRegistry {
  private readonly logger = new Logger(KeyReferenceRegistry.name);
  private checker: KeyReferenceChecker | null = null;
  private jaTeve = false;

  registrar(checker: KeyReferenceChecker): void {
    if (this.checker !== null) {
      // Dois checkers seria dois donos da mesma pergunta, e o worker não tem
      // como saber qual obedecer. Recusar é a única resposta que não escolhe
      // errado em silêncio.
      throw new Error(
        'Já existe um KeyReferenceChecker registrado (MOD-008/INV-044).',
      );
    }
    this.checker = checker;
    this.jaTeve = true;
    this.logger.log('KeyReferenceChecker registrado.');
  }

  /** Só para teste: desregistrar é o cenário "checker que sumiu" (AC-014c). */
  desregistrar(): void {
    this.checker = null;
  }

  temChecker(): boolean {
    return this.checker !== null;
  }

  /** `true` quando um checker já esteve registrado neste processo. */
  jaTeveChecker(): boolean {
    return this.jaTeve;
  }

  /**
   * A pergunta do worker. **Sem checker devolve `true`** — "referenciada" —
   * e é o fail-closed inteiro numa linha.
   */
  async estaReferenciada(key: string): Promise<boolean> {
    if (this.checker === null) {
      return RESULTADO_SEM_CHECKER;
    }
    return this.checker.estaReferenciada(key);
  }
}

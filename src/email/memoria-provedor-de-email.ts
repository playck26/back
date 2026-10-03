import {
  partirEmBlocos,
  type MensagemDeEmail,
  type MotivoDaFalha,
  type ProvedorDeEmail,
  type ResultadoDoEnvio,
} from './provedor-de-email';

/**
 * SPEC-083/D8 — o adaptador de memória.
 *
 * Guarda o que foi aceito, para o teste conferir remetente, destinatário,
 * corpo e link sem rede (AC-041), e pode ser mandado falhar com um motivo,
 * que é como se prova que a importação e o enviar continuam de pé com o
 * provedor fora (AC-026).
 *
 * **Fica tudo em memória, e nada vai a log.** O corpo tem o link com o token;
 * imprimi-lo para "ver o e-mail" em desenvolvimento seria o adaptador "log"
 * que a D8 recusou, por outro nome.
 */
export class MemoriaProvedorDeEmail implements ProvedorDeEmail {
  /** As mensagens aceitas, na ordem. */
  readonly enviados: MensagemDeEmail[] = [];
  /**
   * Uma entrada por chamada que o provedor real receberia: o avulso é um
   * bloco de uma mensagem, e o lote vem partido como a Resend o receberia.
   * Registra também as chamadas que falharam.
   */
  readonly blocos: MensagemDeEmail[][] = [];
  private motivoDaFalha: MotivoDaFalha | null = null;
  private proximoId = 1;

  /** Daqui em diante, toda mensagem falha com `motivo`. `null` volta a aceitar. */
  falharCom(motivo: MotivoDaFalha | null): void {
    this.motivoDaFalha = motivo;
  }

  limpar(): void {
    this.enviados.length = 0;
    this.blocos.length = 0;
    this.motivoDaFalha = null;
  }

  enviar(mensagem: MensagemDeEmail): Promise<ResultadoDoEnvio> {
    this.blocos.push([mensagem]);
    return Promise.resolve(this.aceitar(mensagem));
  }

  enviarLote(
    mensagens: readonly MensagemDeEmail[],
  ): Promise<ResultadoDoEnvio[]> {
    const resultados: ResultadoDoEnvio[] = [];
    for (const bloco of partirEmBlocos(mensagens)) {
      this.blocos.push(bloco);
      resultados.push(...bloco.map((mensagem) => this.aceitar(mensagem)));
    }
    return Promise.resolve(resultados);
  }

  private aceitar(mensagem: MensagemDeEmail): ResultadoDoEnvio {
    if (this.motivoDaFalha) {
      return { ok: false, motivo: this.motivoDaFalha };
    }
    this.enviados.push(mensagem);
    return { ok: true, id: `memoria-${this.proximoId++}` };
  }
}

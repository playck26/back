import type {
  AvisoParaEnviar,
  DestinoDePush,
  PortaDeEnvio,
  ResultadoDeEnvio,
} from './porta-de-envio';

export interface EnvioRegistrado {
  readonly destino: DestinoDePush;
  readonly aviso: AvisoParaEnviar;
  readonly em: Date;
}

/**
 * SPEC-062/D1a — o adaptador de memória.
 *
 * **Duas funções, e a segunda é a que importa.** A primeira é óbvia: sem par
 * VAPID, o ambiente de desenvolvimento precisa de alguma coisa no lugar do
 * envio real.
 *
 * A segunda é a que faz as seis transições serem prováveis: o tick é onde mora
 * a concorrência desta spec — lease, cerca, vencimento entre reivindicar e
 * enviar —, e provar isso contra a rede seria provar a rede. Aqui o teste
 * escolhe o resultado (`responderCom`) e pode **segurar** o envio
 * (`segurarAte`) para fazer o lease vencer com a requisição no ar, que é
 * exatamente o caso que a LIM-062a declara e a AC-012 exige provar.
 */
export class AdaptadorDeMemoria implements PortaDeEnvio {
  private resposta: ResultadoDeEnvio = { tipo: 'aceito' };
  private fila: ResultadoDeEnvio[] = [];
  private travaDeEnvio: Promise<void> | null = null;
  readonly enviados: EnvioRegistrado[] = [];

  responderCom(resultado: ResultadoDeEnvio): void {
    this.resposta = resultado;
  }

  /**
   * Um resultado por envio, na ordem. Serve para o caso da D5 — "uma aceita,
   * outra morre" —, em que os dois aparelhos da mesma pessoa respondem
   * diferente na mesma linha. Esgotada a fila, volta a valer `responderCom`.
   */
  responderEmSequencia(resultados: ResultadoDeEnvio[]): void {
    this.fila = [...resultados];
  }

  /**
   * Segura o PRÓXIMO envio até a promessa resolver. É como o teste faz o lease
   * vencer com o envio ainda no ar, sem `sleep` e sem relógio falso.
   */
  segurarAte(trava: Promise<void>): void {
    this.travaDeEnvio = trava;
  }

  async enviar(
    destino: DestinoDePush,
    aviso: AvisoParaEnviar,
  ): Promise<ResultadoDeEnvio> {
    if (this.travaDeEnvio) {
      const trava = this.travaDeEnvio;
      this.travaDeEnvio = null;
      await trava;
    }
    this.enviados.push({ destino, aviso, em: new Date() });
    return this.fila.shift() ?? this.resposta;
  }
}

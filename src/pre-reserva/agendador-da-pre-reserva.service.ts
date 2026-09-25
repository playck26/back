import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VarredorDaPreReservaService } from './varredor-da-pre-reserva.service';

/** SPEC-074/D7 — de onde sai a LIM-074b: o aviso demora um ciclo. */
export const INTERVALO_DA_PRE_RESERVA_MS = 60 * 1000;

/**
 * SPEC-074/D7 — **o sexto agendador, no molde dos cinco.**
 *
 * Item a item, herdados da SPEC-064/D8: `setInterval`, e não
 * `@nestjs/schedule` (o projeto recusa *"uma dependência inteira para um
 * temporizador"*); **não arma em `NODE_ENV === 'test'`** — a suíte chama
 * `executarCiclo()` direto; um ciclo por vez, com o atrasado **pulado**; roda ao
 * subir; desligado sai em `warn`; log só de números.
 *
 * ## Por que não um passo dentro do varredor da fila
 *
 * **Interruptor.** O rollback da SPEC-064 manda derrubar o varredor da fila
 * PRIMEIRO; se a pré-reserva morasse nele, desligar a fila calaria um aviso que
 * não tem nada a ver com ela. Dois domínios, dois interruptores.
 *
 * ## Desligado, ninguém é avisado
 *
 * `PRE_RESERVA_INTERVALO_MS=0` desliga sem deploy — e quem pediu aviso fica
 * esperando um aviso que não vem, e o silêncio parece "ainda não vagou". Por
 * isso sai em `warn`, com a consequência escrita. **Desligar é para
 * incidente, não para economia.**
 */
@Injectable()
export class AgendadorDaPreReserva implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDaPreReserva.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly varredor: VarredorDaPreReservaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('PRE_RESERVA_INTERVALO_MS') ??
        INTERVALO_DA_PRE_RESERVA_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      this.logger.warn(
        'Pré-reserva DESLIGADA por configuração — ninguém será avisado de horário livre.',
      );
      return;
    }
    this.timer = setInterval(() => void this.executar(), intervalo);
    this.timer.unref();
    // Ao subir, e não só no primeiro intervalo: atraso aqui é pessoa esperando.
    setImmediate(() => void this.executar());
    this.logger.log(`Pré-reserva varrida a cada ${intervalo}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async executar(): Promise<void> {
    if (this.rodando) {
      return;
    }
    this.rodando = true;
    try {
      const resultado = await this.varredor.executarCiclo();
      this.logger.log({ evento: 'pre_reserva', ...resultado });
    } catch (causa) {
      // Erro não pode derrubar o temporizador: o próximo ciclo tenta de novo.
      // Só a CLASSE do erro — a mensagem de um erro do banco pode trazer valor
      // de coluna, e o log é só de números.
      this.logger.error({
        evento: 'pre_reserva_falhou',
        detalhe: causa instanceof Error ? causa.name : 'desconhecido',
      });
    } finally {
      this.rodando = false;
    }
  }
}

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerDeExclusao } from './worker-de-exclusao.service';

export const INTERVALO_PADRAO_MS = 5 * 60 * 1000;

/**
 * SPEC-017/TASK-005 — o que faz o worker rodar.
 *
 * **`setInterval` e não `@nestjs/schedule`**, e é decisão de peso, não de
 * preguiça: o projeto não tem nenhum outro job agendado, e uma dependência
 * inteira para um temporizador é superfície nova em troca de açúcar
 * sintático. Quando existir o segundo job, a troca se justifica; hoje ela é
 * um `import` a mais no `package.json` para sempre.
 *
 * **Um tick por vez.** Se um ciclo demorar mais que o intervalo, o próximo é
 * pulado em vez de empilhar — dois workers concorrentes não quebram nada (o
 * advisory lock serializa), mas dobrariam o consumo de conexão do pool sem
 * apagar nada a mais.
 *
 * **Não roda em teste.** Timer disparando no meio de suíte é falha
 * intermitente pronta; quem testa o worker chama `executarCiclo()` direto, e
 * é assim que a suíte de banco faz.
 */
@Injectable()
export class AgendadorDeExclusao implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDeExclusao.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly worker: WorkerDeExclusao,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('STORAGE_WORKER_INTERVALO_MS') ??
        INTERVALO_PADRAO_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      this.logger.warn('Worker de exclusão desligado por configuração.');
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalo);
    // `unref` para o temporizador não segurar o processo vivo num shutdown.
    this.timer.unref();
    this.logger.log(`Worker de exclusão a cada ${intervalo}ms.`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.rodando) {
      return;
    }
    this.rodando = true;
    try {
      const resultado = await this.worker.executarCiclo();
      if (resultado.elegiveis > 0 || resultado.pausado) {
        this.logger.log({ evento: 'ciclo_de_exclusao', ...resultado });
      }
    } catch (causa) {
      // Ciclo que explode não pode derrubar o temporizador: o próximo tick
      // tem de acontecer, senão um erro transitório para a fila para sempre.
      this.logger.error({
        evento: 'ciclo_de_exclusao_falhou',
        detalhe: causa instanceof Error ? causa.message : String(causa),
      });
    } finally {
      this.rodando = false;
    }
  }
}

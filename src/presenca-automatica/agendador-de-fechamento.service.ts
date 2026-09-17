import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FechamentoAutomaticoService } from './fechamento-automatico.service';

export const INTERVALO_DO_FECHAMENTO_MS = 60 * 60 * 1000;

/**
 * SPEC-057/TASK-001/D2 — **o que faz o fechamento automático rodar.**
 *
 * O mesmo padrão do `AgendadorDeExclusao` (SPEC-017), e pelas mesmas razões:
 * `setInterval` sem dependência nova, **um tick por vez** (se um ciclo passar
 * da hora, o seguinte é pulado em vez de empilhar) e **nunca em teste** — a
 * suíte chama `executarTick()` direto.
 *
 * Roda ao iniciar e a cada hora. Rodar ao iniciar é o que faz um redeploy não
 * atrasar o fechamento em até uma hora; rodar sem nada a fazer custa a
 * leitura do catálogo e da configuração.
 *
 * **Ligar o job não é aqui.** Este temporizador sobe em todo ambiente, e o que
 * decide se ele fecha alguma coisa é a configuração no banco, que só o
 * operador altera pela função (D3). `PRESENCA_AUTO_INTERVALO_MS=0` desliga o
 * temporizador do processo — é chave de emergência local, não autorização.
 */
@Injectable()
export class AgendadorDeFechamento implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDeFechamento.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly fechamento: FechamentoAutomaticoService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('PRESENCA_AUTO_INTERVALO_MS') ??
        INTERVALO_DO_FECHAMENTO_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      this.logger.warn('Fechamento automático desligado por configuração.');
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalo);
    this.timer.unref();
    // Ao iniciar, sem segurar o bootstrap: o primeiro tick lê o catálogo.
    setImmediate(() => void this.tick());
    this.logger.log(`Fechamento automático a cada ${intervalo}ms.`);
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
      const resultado = await this.fechamento.executarTick();
      // NFR-003 — um log por tick com os números, e só números: nenhum nome,
      // ID de aluno ou credencial.
      this.logger.log({ evento: 'presenca_automatica_tick', ...resultado });
    } catch (causa) {
      this.logger.error({
        evento: 'presenca_automatica_tick_falhou',
        detalhe: causa instanceof Error ? causa.name : 'desconhecido',
      });
    } finally {
      this.rodando = false;
    }
  }
}

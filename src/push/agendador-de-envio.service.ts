import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickDeEnvioService } from './tick-de-envio.service';

/** Um minuto. Aviso de clube não precisa de segundos; a fila precisa de ritmo. */
export const INTERVALO_DE_ENVIO_MS = 60 * 1000;

/**
 * SPEC-062/D4a — **o que faz o tick rodar.**
 *
 * O mesmo padrão do `AgendadorDeFechamento` (SPEC-057) e do
 * `AgendadorDeExclusao` (SPEC-017), e pelas mesmas razões: `setInterval` sem
 * dependência nova, **um tick por vez** (ciclo atrasado é pulado, não
 * empilhado) e **nunca em teste** — a suíte chama `executarTick()` direto, que
 * é o que torna as seis transições prováveis sem relógio.
 *
 * **Ligar o push não é aqui.** Este temporizador sobe em todo ambiente; quem
 * decide se alguma coisa sai é o par VAPID (D1b). Sem ele o tick devolve
 * `configurado: false` e não reivindica nada — falha fechada, e nenhuma linha
 * some em silêncio por falta de configuração.
 */
@Injectable()
export class AgendadorDeEnvio implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDeEnvio.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly tick: TickDeEnvioService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('PUSH_INTERVALO_MS') ?? INTERVALO_DE_ENVIO_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      this.logger.warn('Envio de push desligado por configuração.');
      return;
    }
    this.timer = setInterval(() => void this.executar(), intervalo);
    this.timer.unref();
    setImmediate(() => void this.executar());
    this.logger.log(`Envio de push a cada ${intervalo}ms.`);
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
      const resultado = await this.tick.executarTick();
      // Só números e estados — nenhum nome, id de pessoa ou credencial.
      // `cercadas` é o que o operador precisa ver subir: significa lease
      // vencido com envio no ar, que é a LIM-062a acontecendo.
      this.logger.log({ evento: 'push_tick', ...resultado });
    } catch (causa) {
      this.logger.error({
        evento: 'push_tick_falhou',
        detalhe: causa instanceof Error ? causa.name : 'desconhecido',
      });
    } finally {
      this.rodando = false;
    }
  }
}

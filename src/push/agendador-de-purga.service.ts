import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PurgaDeAvisosService } from './purga-de-avisos.service';

/**
 * De hora em hora (SPEC-065/D12).
 *
 * **Não uma vez por dia**, como a v2 da spec dizia: com lotes curtos não há
 * razão para concentrar o trabalho num instante, e 24 oportunidades por dia
 * dão 24× mais folga contra o atraso.
 */
export const INTERVALO_DA_PURGA_MS = 60 * 60 * 1000;

/**
 * SPEC-065/TASK-002 — **o que faz a purga rodar.**
 *
 * Quarto agendador do projeto, e o quarto no mesmo molde: `AgendadorDeExclusao`
 * (SPEC-017), `AgendadorDeFechamento` (SPEC-057) e `AgendadorDeEnvio`
 * (SPEC-062). `setInterval` e **não `@nestjs/schedule`** — o projeto recusa
 * *"uma dependência inteira para um temporizador"*.
 *
 * Três coisas que o molde carrega, e cada uma tem razão:
 *
 * - **nunca em teste** (`NODE_ENV=test` sai antes de armar): a suíte chama
 *   `executarCiclo()` direto, que é o que torna a purga provável sem relógio;
 * - **um ciclo por vez** — ciclo atrasado é **pulado**, não empilhado. Dois
 *   ciclos concorrentes na mesma réplica disputariam o próprio lock;
 * - **`AVISOS_PURGA_INTERVALO_MS=0` desliga sem deploy.** É a saída de
 *   emergência, e a única coisa desta spec que apaga dado precisa de uma.
 *
 * **Não roda ao subir.** O `AgendadorDeEnvio` e o de fechamento disparam um
 * ciclo imediato porque atraso ali é aviso que não chega; aqui, atraso é
 * linha velha que fica mais uma hora. Um `setImmediate` só faria cada deploy
 * pagar uma varredura à toa.
 */
@Injectable()
export class AgendadorDePurga implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDePurga.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly purga: PurgaDeAvisosService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('AVISOS_PURGA_INTERVALO_MS') ??
        INTERVALO_DA_PURGA_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      this.logger.warn('Purga de avisos desligada por configuração.');
      return;
    }
    this.timer = setInterval(() => void this.executar(), intervalo);
    this.timer.unref();
    this.logger.log(`Purga de avisos a cada ${intervalo}ms.`);
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
      const resultado = await this.purga.executarCiclo();
      // Só números e estados — nenhum id, nome ou credencial.
      //
      // **`restantes` é o que o operador precisa ver:** subindo de hora em
      // hora, significa que a purga deixou de alcançar o que entra, e a
      // conta de capacidade da D13 envelheceu.
      this.logger.log({ evento: 'purga_de_avisos', ...resultado });
    } catch (causa) {
      // Erro não pode derrubar o temporizador: o próximo ciclo tenta de novo.
      this.logger.error({
        evento: 'purga_de_avisos_falhou',
        detalhe: causa instanceof Error ? causa.name : 'desconhecido',
      });
    } finally {
      this.rodando = false;
    }
  }
}

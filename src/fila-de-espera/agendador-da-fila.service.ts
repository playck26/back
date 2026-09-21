import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VarredorDaFilaService } from './varredor-da-fila.service';

/**
 * D8 — 1 min. **É daqui que sai a LIM-064b**, que deixa de ser prosa:
 * *"a vez demora até um ciclo"* passa a ser *"até `INTERVALO_DA_FILA_MS`"*.
 */
export const INTERVALO_DA_FILA_MS = 60 * 1000;

/**
 * SPEC-064/D8 — **o QUINTO agendador, e no mesmo molde dos quatro.**
 *
 * | Agendador | Env | Padrão |
 * |---|---|---|
 * | `AgendadorDeExclusao` (SPEC-017) | `STORAGE_WORKER_INTERVALO_MS` | 5 min |
 * | `AgendadorDeFechamento` (SPEC-057) | `PRESENCA_AUTO_INTERVALO_MS` | 1 h |
 * | `AgendadorDeEnvio` (SPEC-062) | `PUSH_INTERVALO_MS` | 60 s |
 * | `AgendadorDePurga` (SPEC-065) | `AVISOS_PURGA_INTERVALO_MS` | 1 h |
 * | **este** | **`FILA_DE_ESPERA_INTERVALO_MS`** | **60 s** |
 *
 * A v2 da spec dizia *"o varredor tem interruptor por variável de ambiente"* e
 * **não nomeava a variável**, nem a constante, nem o que acontece em teste, nem
 * se dois ciclos podem se sobrepor. Isso é intenção, não mecanismo — e foi o
 * terceiro bloqueio da 1ª rodada de validação.
 *
 * Item a item:
 *
 * - **`setInterval`, não `@nestjs/schedule`** — o projeto recusa *"uma
 *   dependência inteira para um temporizador"*;
 * - **não sobe em teste**: a suíte chama `executarCiclo()` direto, e é isso que
 *   torna o varredor provável **sem relógio**;
 * - **um ciclo por vez**: ciclo atrasado é **pulado**, não empilhado;
 * - **roda ao subir** (`setImmediate`), como o de envio e o de fechamento — e
 *   diferente do de exclusão. A razão é a mesma do de envio: **atraso aqui é
 *   pessoa esperando**, não linha velha no banco;
 * - **o log é só de números.** Nenhum id, nome ou credencial.
 *
 * ## É o único dos cinco que, desligado, deixa gente esperando
 *
 * Os outros quatro atrasam trabalho de máquina. `FILA_DE_ESPERA_INTERVALO_MS=0`
 * deixa **pessoas** esperando um chamado que não vem, e o silêncio parece
 * *"ainda não é a sua vez"*. Por isso o rollback manda derrubá-lo **primeiro**,
 * e por isso o desligamento sai em `warn` — não em `log`.
 */
@Injectable()
export class AgendadorDaFila implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgendadorDaFila.name);
  private timer: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(
    private readonly varredor: VarredorDaFilaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }
    const intervalo = Number(
      this.config.get<string>('FILA_DE_ESPERA_INTERVALO_MS') ??
        INTERVALO_DA_FILA_MS,
    );
    if (!Number.isFinite(intervalo) || intervalo <= 0) {
      // `warn`, e com a consequência escrita: quem ler o log precisa saber que
      // isto não é "um worker a menos", é gente na fila sem ser chamada.
      this.logger.warn(
        'Fila de espera DESLIGADA por configuração — ninguém será chamado.',
      );
      return;
    }
    this.timer = setInterval(() => void this.executar(), intervalo);
    this.timer.unref();
    // Ao subir, e não só no primeiro intervalo: atraso aqui é pessoa esperando.
    setImmediate(() => void this.executar());
    this.logger.log(`Fila de espera varrida a cada ${intervalo}ms.`);
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
      this.logger.log({ evento: 'fila_de_espera', ...resultado });
    } catch (causa) {
      // Erro não pode derrubar o temporizador: o próximo ciclo tenta de novo.
      this.logger.error({
        evento: 'fila_de_espera_falhou',
        detalhe: causa instanceof Error ? causa.name : 'desconhecido',
      });
    } finally {
      this.rodando = false;
    }
  }
}

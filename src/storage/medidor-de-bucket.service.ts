import { Inject, Injectable, Logger } from '@nestjs/common';
import { ALERTAS, AlertaDeStorage } from './alerta-de-storage';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage-provider.interface';

/**
 * SPEC-017/TASK-006 — o alerta de bucket grande.
 *
 * **50 GB não é o limite do bucket; é o limite da conta dividido por dois.**
 * A assinatura do Spaces cobre 250 GB somados entre todos os buckets, e o
 * `opinii-media` está na mesma conta (ADR-015). Alertar aos 50 GB dá margem
 * enorme para reagir antes de o produto do lado começar a pagar por um
 * problema que não é dele.
 */
export const LIMITE_DO_BUCKET_BYTES = 50 * 1024 * 1024 * 1024;

/**
 * Teto de páginas da varredura. Cada página são 1000 objetos, então 200
 * páginas cobrem 200 mil arquivos — muito além do que este produto terá.
 *
 * O teto existe porque **medição que pode rodar para sempre é medição que um
 * dia trava o processo**: se o bucket crescer além disso, a resposta vem
 * marcada como incompleta e o alerta dispara do mesmo jeito, o que é a
 * conclusão certa (bucket grande demais para varrer é bucket grande demais).
 */
export const MAXIMO_DE_PAGINAS = 200;

export interface UsoDoBucket {
  readonly objetos: number;
  readonly bytes: number;
  /** `false` quando a varredura bateu no teto de páginas. */
  readonly completo: boolean;
}

@Injectable()
export class MedidorDeBucket {
  private readonly logger = new Logger(MedidorDeBucket.name);

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
    private readonly alerta: AlertaDeStorage,
  ) {}

  async medirEAlertar(): Promise<UsoDoBucket> {
    const uso = await this.provider.medirUso(MAXIMO_DE_PAGINAS);

    if (uso.bytes > LIMITE_DO_BUCKET_BYTES || !uso.completo) {
      this.alerta.disparar(ALERTAS.BUCKET_GRANDE, {
        gigabytes: Math.round((uso.bytes / 1024 / 1024 / 1024) * 10) / 10,
        objetos: uso.objetos,
        completo: uso.completo,
      });
    }

    this.logger.log({
      evento: 'uso_do_bucket',
      objetos: uso.objetos,
      bytes: uso.bytes,
      completo: uso.completo,
    });
    return uso;
  }
}

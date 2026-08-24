import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3StorageProvider } from './s3-storage.provider';
import { StorageService } from './storage.service';
import { STORAGE_PROVIDER } from './storage-provider.interface';
import {
  carregarStorageConfig,
  STORAGE_CONFIG,
  type StorageConfig,
} from './storage.config';

/**
 * SPEC-017 — MOD-008 (StorageMedia).
 *
 * Exporta a **porta**, nunca o adaptador: quem injeta `STORAGE_PROVIDER`
 * não tem como saber que existe um S3 do outro lado (AC-017/INV-031).
 *
 * O provider de config é resolvido no boot, e é de propósito: a validação
 * de `storage.config.ts` roda quando o app sobe, não quando o primeiro
 * upload chega.
 */
@Module({
  providers: [
    {
      provide: STORAGE_CONFIG,
      useFactory: (config: ConfigService): StorageConfig =>
        carregarStorageConfig(config),
      inject: [ConfigService],
    },
    { provide: STORAGE_PROVIDER, useClass: S3StorageProvider },
    StorageService,
  ],
  // **Exporta só a porta.** `STORAGE_CONFIG` carrega `key` e `secret`, e
  // exportá-lo abria uma fronteira pública para o segredo sem nenhum
  // consumidor pedindo (achado da validação cruzada de 2026-08-24). Quem
  // precisar de configuração de storage fora daqui precisa justificar.
  // `StorageService` é o que a SPEC-018 consome. `STORAGE_PROVIDER` sai
  // junto porque o worker da TASK-005 apaga por chave já conferida, sem
  // passar pelo caminho de leitura.
  exports: [StorageService, STORAGE_PROVIDER],
})
export class StorageModule {}

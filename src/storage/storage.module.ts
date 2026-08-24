import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3StorageProvider } from './s3-storage.provider';
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
  ],
  exports: [STORAGE_PROVIDER, STORAGE_CONFIG],
})
export class StorageModule {}

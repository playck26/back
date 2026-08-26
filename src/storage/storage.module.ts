import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AgendadorDeExclusao } from './agendador-de-exclusao.service';
import { AlertaDeStorage, AlertaPorLog } from './alerta-de-storage';
import { FilaDeExclusao } from './fila-de-exclusao.service';
import { CheckerDeReferencia } from './checker-de-referencia.service';
import { KeyReferenceRegistry } from './key-reference-checker';
import { MedidorDeBucket } from './medidor-de-bucket.service';
import { S3StorageProvider } from './s3-storage.provider';
import { StorageService } from './storage.service';
import { WorkerDeExclusao } from './worker-de-exclusao.service';
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
  // `PrismaModule` é `@Global` e já vem do `AppModule`, mas importar aqui
  // torna o `StorageModule` auto-suficiente: ele compila sozinho num
  // `Test.createTestingModule`, e é assim que a fiação é testada.
  imports: [PrismaModule],
  providers: [
    {
      provide: STORAGE_CONFIG,
      useFactory: (config: ConfigService): StorageConfig =>
        carregarStorageConfig(config),
      inject: [ConfigService],
    },
    { provide: STORAGE_PROVIDER, useClass: S3StorageProvider },
    StorageService,
    // A fila e o worker (TASK-005). O `AlertaDeStorage` é porta e não
    // `Logger` direto porque o teste precisa provar que o alerta disparou —
    // e provar isso lendo log seria testar a formatação.
    { provide: AlertaDeStorage, useClass: AlertaPorLog },
    KeyReferenceRegistry,
    // SPEC-018/TASK-007 — a implementacao do checker, que se registra
    // sozinha no boot. E o que tira o worker do fail-closed (AC-016):
    // ate aqui ele nao apagava nada, por nao saber quem aponta.
    CheckerDeReferencia,
    FilaDeExclusao,
    WorkerDeExclusao,
    AgendadorDeExclusao,
    // TASK-006 — NFR-004. O `ThrottlerDeUpload` não entra aqui: ele é
    // aplicado por rota, pelo `@UploadDeMidia()`, e o Nest o instancia a
    // partir do `UseGuards`.
    MedidorDeBucket,
  ],
  // **Exporta só a porta.** `STORAGE_CONFIG` carrega `key` e `secret`, e
  // exportá-lo abria uma fronteira pública para o segredo sem nenhum
  // consumidor pedindo (achado da validação cruzada de 2026-08-24). Quem
  // precisar de configuração de storage fora daqui precisa justificar.
  // `StorageService` é o que a SPEC-018 consome. `STORAGE_PROVIDER` sai
  // junto porque o worker da TASK-005 apaga por chave já conferida, sem
  // passar pelo caminho de leitura.
  // `KeyReferenceRegistry` sai porque é **API pública do MOD-008**: é por
  // ele que a SPEC-018 registra o checker que tira o worker do fail-closed.
  // `FilaDeExclusao` sai porque a INV-038 obriga quem apaga uma referência a
  // enfileirar na MESMA transação.
  exports: [
    StorageService,
    STORAGE_PROVIDER,
    KeyReferenceRegistry,
    FilaDeExclusao,
  ],
})
export class StorageModule {}

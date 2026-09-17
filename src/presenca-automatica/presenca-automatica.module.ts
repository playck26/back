import { Module } from '@nestjs/common';
import { AgendadorDeFechamento } from './agendador-de-fechamento.service';
import { CorteDaPresenca } from './corte-da-presenca';
import { FechamentoAutomaticoService } from './fechamento-automatico.service';

/**
 * SPEC-057/TASK-001 — presença automática.
 *
 * Módulo próprio porque o corte é lido por dois módulos que já se importam
 * numa direção só (`ClassesModule` → `FrequenciaModule`), e o worker não
 * pertence a nenhum dos dois. Depende só do Prisma, que é global.
 *
 * Não há controller: **nenhuma rota HTTP ativa ou pausa** o job (D3). A
 * credencial da aplicação não tem `EXECUTE` na função operacional, então uma
 * rota não conseguiria nem se existisse.
 */
@Module({
  providers: [
    CorteDaPresenca,
    FechamentoAutomaticoService,
    AgendadorDeFechamento,
  ],
  exports: [CorteDaPresenca],
})
export class PresencaAutomaticaModule {}

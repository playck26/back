import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AdaptadorWebPush } from './adaptador-web-push';
import { AgendadorDeEnvio } from './agendador-de-envio.service';
import { PORTA_DE_ENVIO, type PortaDeEnvio } from './porta-de-envio';
import { PushController, PushPublicoController } from './push.controller';
import { PushService } from './push.service';
import { TickDeEnvioService } from './tick-de-envio.service';
import { CaixaDeAvisosService } from './caixa-de-avisos.service';
import { PurgaDeAvisosService } from './purga-de-avisos.service';
import { AgendadorDePurga } from './agendador-de-purga.service';
import { MeAvisosController } from './me-avisos.controller';
import {
  lerEstadoDoVapid,
  registrarEstadoNoBoot,
  type ConfiguracaoVapid,
} from './vapid.config';

export const CONFIGURACAO_VAPID = Symbol('CONFIGURACAO_VAPID');

/**
 * SPEC-062 — infraestrutura de push.
 *
 * **É aqui que a falha fechada acontece**, e é por isso que os dois provedores
 * abaixo são fábricas: sem par VAPID, a configuração é `null` e a porta de
 * envio **não existe**. Não há adaptador de mentirinha assumindo o lugar dela
 * em produção — o tick devolve `configurado: false`, a rota de assinar responde
 * `503` e nada é reivindicado.
 *
 * A alternativa (um adaptador nulo que "envia" e descarta) é o oposto do que a
 * D1c pede: funcionaria em silêncio, e o operador descobriria por reclamação de
 * aluno.
 */
@Module({
  controllers: [PushPublicoController, PushController, MeAvisosController],
  providers: [
    {
      provide: CONFIGURACAO_VAPID,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ConfiguracaoVapid | null => {
        const estado = lerEstadoDoVapid(config);
        // D1c/1 — uma vez, no boot, com os NOMES do que falta. Nunca valores.
        registrarEstadoNoBoot(estado, new Logger('PushVapid'));
        return estado.configuracao;
      },
    },
    {
      provide: PORTA_DE_ENVIO,
      inject: [CONFIGURACAO_VAPID],
      useFactory: (vapid: ConfiguracaoVapid | null): PortaDeEnvio | null =>
        vapid ? new AdaptadorWebPush(vapid) : null,
    },
    {
      provide: PushService,
      inject: [PrismaService, CONFIGURACAO_VAPID],
      useFactory: (prisma: PrismaService, vapid: ConfiguracaoVapid | null) =>
        new PushService(prisma, vapid),
    },
    TickDeEnvioService,
    AgendadorDeEnvio,
    // SPEC-065 — a caixa de ENTRADA. Provider normal: ela só lê a tabela e
    // grava `lida_em`, e não depende do par VAPID nem da porta de envio.
    CaixaDeAvisosService,
    // SPEC-065/TASK-002 — a purga e o quarto agendador do projeto, no mesmo
    // molde dos tres existentes. `AVISOS_PURGA_INTERVALO_MS=0` desliga.
    PurgaDeAvisosService,
    AgendadorDePurga,
  ],
  exports: [PushService],
})
export class PushModule {}
